/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const protoLoader = require('@grpc/proto-loader')
const grpc = require('../proxy/grpc')
const logger = require('../logger').child({component: 'grpc_connection'})
const EventEmitter = require('events')
const NAMES = require('../metrics/names')
const util = require('util')

const connectionStates = require('./connection/states')

const PROTO_OPTIONS = {keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
}

const PROTO_DEFINITION_PATH = __dirname +
  '../../../lib/grpc/endpoints/infinite-tracing/v1.proto'

const DEFAULT_RECONNECT_DELAY_MS = 15 * 1000

/**
 * Class for managing the GRPC connection
 *
 * Both @grpc/grpc-js and grpc will manage the http2 connections
 * for us -- this class manages the _stream_ connection logic.
 *
 * Will emit events based on the connectionStates (see above
 */
class GrpcConnection extends EventEmitter {
  /**
   * GrpcConnection constructor
   *
   * Standard property setting/initialization, and sets an initial
   * connection state of disconnected
   *
   * @param {Object} traceObserverConfig config item config.infinite_tracing.trace_observer
   * @param {MetricAggregator} metrics metric aggregator, for supportability metrics
   * @param {Number} [reconnectDelayMs=15000] number of milliseconds to wait before reconnecting
   * for error states that require a reconnect delay.
   */
  constructor(traceObserverConfig, metrics, reconnectDelayMs) {
    super()

    this._reconnectDelayMs = reconnectDelayMs || DEFAULT_RECONNECT_DELAY_MS

    this._metrics = metrics
    this._setState(connectionStates.disconnected)

    this._licensekey = null
    this._runId = null
    this._requestHeadersMap = null

    this._endpoint = this.getTraceObserverEndpoint(traceObserverConfig)

    this._client = null
    this.stream = null
  }

  /**
   * Sets connection details
   *
   * Allows setting of connection details _after_ object constructions
   * but before the actual connection.
   *
   * @param {string} endpoint the GRPC server's endpoint
   * @param {string} license_key the agent license key
   * @param {string} run_id the current agent run id (also called agent run token)
   * @param {object} requestHeadersMap request headers map received from server connect.
   * @param {string} [rootCerts] string of root (ca) certificates to attach to the connection.
   */
  setConnectionDetails(license_key, run_id, requestHeadersMap, rootCerts) {
    this._licenseKey = license_key
    this._runId = run_id
    this._requestHeadersMap = requestHeadersMap
    this._rootCerts = rootCerts

    return this
  }

  getTraceObserverEndpoint(traceObserverConfig) {
    return `${traceObserverConfig.host}:${traceObserverConfig.port}`
  }

  /**
   * Sets the connection state
   *
   * Used to indicate a transition from one connection state to
   * the next.  Also responsible for emitting the connect state event
   *
   * @param {int} state The connection state (See connectionStates above)
   * @param {ClientDuplexStreamImpl} state The GRPC stream, when defined
   */
  _setState(state, stream = null) {
    this._state = state
    this.emit(connectionStates[state], stream)
  }

  /**
   * Start the Connection
   *
   * Public Entry point -- initiates a connection
   */
  connectSpans() {
    if (this._state !== connectionStates.disconnected) {
      return
    }

    this._setState(connectionStates.connecting)
    logger.trace('Connecting to gRPC endpoint.')

    try {
      this.stream = this._connectSpans()

      // May not actually be "connected" at this point but we can write to the stream
      // immediately.
      this._setState(connectionStates.connected, this.stream)
    } catch (err) {
      logger.warn(
        err,
        'Unexpected error establishing gRPC stream, will not attempt reconnect.'
      )
      this._disconnect()
    }
  }

  /**
   * End the current stream and set state to disconnected.
   *
   * No more data can be sent until connected again.
   */
  disconnect() {
    if (this._state === connectionStates.disconnected) {
      return
    }

    this._disconnect()
  }

  /**
   * Method returns GRPC metadata for initial connection
   *
   * @param {string} license_key
   * @param {string} run_id
   */
  _getMetadata(license_key, run_id, requestHeadersMap, env) {
    const metadata = new grpc.Metadata()
    metadata.add('license_key', license_key)
    metadata.add('agent_run_token', run_id)

    // p17 spec: If request_headers_map is empty or absent,
    // the agent SHOULD NOT apply anything to its requests.
    if (requestHeadersMap) {
      for (const [key, value] of Object.entries(requestHeadersMap)) {
        metadata.add(key.toLowerCase(), value) // keys MUST be lowercase for Infinite Tracing
      }
    }

    // check environment variables for testing parameters and
    // pass to server via meta-data.
    const flaky = parseInt(env.NEWRELIC_GRPCCONNECTION_METADATA_FLAKY, 10)
    const delay = parseInt(env.NEWRELIC_GRPCCONNECTION_METADATA_DELAY, 10)
    if (flaky) {
      logger.trace('Adding flaky metadata: %s', flaky)
      metadata.add('flaky', flaky)
    }
    if (delay) {
      logger.trace('Adding delay metadata: %s', delay)
      metadata.add('delay',delay)
    }

    return metadata
  }

  /**
   * Disconnects from gRPC endpoint and schedules establishing a new connection.
   * @param {number} reconnectDelayMs number of milliseconds to wait before reconnecting.
   */
  _reconnect(reconnectDelayMs = 0) {
    this._disconnect()

    logger.trace('Reconnecting to gRPC endpoint in [%s] seconds', reconnectDelayMs)

    setTimeout(
      this.connectSpans.bind(this),
      reconnectDelayMs
    )
  }

  _disconnect() {
    logger.trace('Disconnecting from gRPC endpoint.')

    if (this.stream) {
      this.stream.removeAllListeners()

      const oldStream = this.stream
      this.stream.on('status', function endStreamStatusHandler(grpcStatus) {
        logger.trace('End stream status received [%s]: %s', grpcStatus.code, grpcStatus.details)

        // Cleanup the final end stream listeners.
        oldStream.removeAllListeners()
      })

      // Listen to any final errors to prevent throwing.
      // This is unlikely but if the server closes post
      // removing listeners and prior to response it could
      // happen. We noticed this via tests on Node 14.
      this.stream.on('error', function endStreamErrorHandler(err) {
        logger.trace('End stream error received. Code: [%s]: %s', err.code, err.details)
      })

      // Indicates to server we are done.
      // Server officially closes the stream.
      this.stream.end()

      this.stream = null
    }

    this._setState(connectionStates.disconnected)
  }

  /**
   * Central location to setup stream observers
   *
   * Events from the GRPC stream (a ClientDuplexStreamImpl) are the main way
   * we communicate with the GRPC server.
   *
   * @param {ClientDuplexStreamImpl} stream
   */
  _setupSpanStreamObservers(stream) {
    // Node streams require all data sent by the server to be read before the end
    // (or status in this case) event gets fired. As such, we have to subscribe even
    // if we are not going to use the data.
    stream.on('data', function data(response) {
      if (logger.traceEnabled()) {
        logger.trace("gRPC span response stream: %s", JSON.stringify(response))
      }
    })

    // listen for status that indicate stream has ended,
    // and we need to disconnect
    stream.on('status', (grpcStatus) => {
      logger.trace('gRPC Status Received [%s]: %s', grpcStatus.code, grpcStatus.details)
      const grpcStatusName =
        grpc.status[grpcStatus.code] ? grpc.status[grpcStatus.code] : 'UNKNOWN'

      if (grpc.status[grpc.status.UNIMPLEMENTED] === grpcStatusName) {
        this._metrics.getOrCreateMetric(
          NAMES.INFINITE_TRACING.SPAN_RESPONSE_GRPC_UNIMPLEMENTED
        ).incrementCallCount()

        // per the spec, An UNIMPLEMENTED status code from gRPC indicates
        // that the versioned Trace Observer is no longer available. Agents
        // MUST NOT attempt to reconnect in this case
        logger.info(
          '[UNIMPLEMENTED]: Trace Obserserver is no longer available. Shutting down connection.'
        )
        this._disconnect()
      } else if (grpc.status[grpc.status.OK] === grpcStatusName) {
        this._reconnect()
      } else {
        this._metrics.getOrCreateMetric(
          util.format(NAMES.INFINITE_TRACING.SPAN_RESPONSE_GRPC_STATUS, grpcStatusName)
        ).incrementCallCount()

        this._reconnect(this._reconnectDelayMs)
      }
    })

    // if we don't listen for the errors they'll bubble
    // up and crash the application
    stream.on('error', (err) => {
      this._metrics.getOrCreateMetric(NAMES.INFINITE_TRACING.SPAN_RESPONSE_ERROR)
        .incrementCallCount()

      // For errors, the status will either result in a disconnect or a reconnect
      // delay that should prevent too frequent spamming. Unless the app is idle
      // and regularly getting Status 13 reconnects from the server, in which case
      // this will be almost the only logging.
      logger.warn('Span stream error. Code: [%s]: %s', err.code, err.details)
    })
  }

  /**
   * Creates the GRPC credentials needed
   */
  _generateCredentials(grpcApi) {
    let certBuffer = null

    // Current settable value for testing. If allowed to be overridden via
    // configuration, this should be removed in place of setting
    // this._rootCerts from config via normal configuration precedence.
    const envTestCerts = process.env.NEWRELIC_GRPCCONNECTION_CA
    const rootCerts = this._rootCerts || envTestCerts
    if (rootCerts) {
      logger.debug('Infinite tracing root certificates found to attach to requests.')
      try {
        certBuffer = Buffer.from(rootCerts, 'utf-8')
      } catch (err) {
        logger.warn('Failed to create buffer from rootCerts, proceeding without.', err)
      }
    }

    // null/undefined ca treated same as calling createSsl()
    return grpcApi.credentials.createSsl(certBuffer)
  }

  /**
   * Internal/private method for connection
   *
   * Contains the actual logic that connects to the GRPC service.
   * "Connection" can be a somewhat misleading term here.  This method
   * invokes the "recordSpan" remote proceduce call. Behind the scenes
   * this makes an http2 request with the metadata, and then returns
   * a stream for further writing.
   */
  _connectSpans() {
    if (!this._client) {
      // Only create once to avoid potential memory leak.
      // We create here (currently) for consistent error handling.
      this._client = this._createClient(this._endpoint)
    }

    const metadata =
      this._getMetadata(this._licenseKey, this._runId, this._requestHeadersMap, process.env)

    const stream = this._client.recordSpan(metadata)
    this._setupSpanStreamObservers(stream)

    return stream
  }

  /**
   * Creates gRPC service client to use for establishing gRPC streams.
   *
   * WARNING: creating a client more than once can result in a memory leak.
   * ChannelImplementation and related objects will stay in memory even after
   * the stream is closed and we do not have a handle to the client. Currently
   * impacting grpc-js@1.2.11 and several earlier versions.
   */
  _createClient(endpoint) {
    logger.trace('Creating gRPC client for: ', endpoint)

    const packageDefinition = protoLoader.loadSync(PROTO_DEFINITION_PATH, PROTO_OPTIONS)

    const protoDescriptor = grpc.loadPackageDefinition(
      packageDefinition
    )

    const traceApi = protoDescriptor.com.newrelic.trace.v1

    const credentials = this._generateCredentials(grpc)
    const client = new traceApi.IngestService(
      endpoint,
      credentials
    )

    return client
  }
}

module.exports = GrpcConnection
