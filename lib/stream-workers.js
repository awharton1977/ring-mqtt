// Simple worker thread implementation for WebRTC live calls.
//
// Ring now uses WebRTC as the primary streaming protocol for both web browsers
// and mobile apps.  As NodeJS does not have a native WebRTC implementation
// ring-client-api leverages the werift package which is an implementation of
// WebRTC completely in Typescript.
//
// The werift code offers excellent WebRTC compatibility but handling the inbound
// RTP traffic, including the decryption of SRTP packets, completely within
// Typescript/Javascript has quite significant CPU overhead.  While this is not a
// significant issue on typical Intel processors from the last decade, it is far
// more noticable on low-power CPUs like the ARM processors in common devices
// such as the Raspberry Pi 3/4.  Even as few as 2 streams can completely saturate
// a single core and keep the main NodeJS thread busy and struggling to keep up with
// the inbound RTP stream.
//
// This implementation allows live calls to be assigned to a pool of worker threads
// rather than running in the main thread, allowing these calls to take advantage
// of the additional CPU cores.  This increases the number of parallel WebRTC streams
// that can be supported on these low powered CPUs.  Testing shows that an RPi 4 is
// able to support ~4 streams reliably, in some cases maybe a 5th or even 6th stream,
// while using ~75-80% of the available CPU resources.
//
// Note that to get the best reliability and least videos artifacts, the default Linux
// socket buffers (net.core.rmem_default/max) should be increased from their default values
// (~200K) to at least 1MB, with 2-4MB providing the best reliability with only slightly
// increased latency during heavy loads with mulitple streaming sessions.

const { Worker } = require('worker_threads')
const utils = require('./utils')
const colors = require('colors/safe')

class StreamWorkers {
    constructor() {
        this.streamWorkers = []
    }

    init() {
        const cpuCores = utils.getCpuCores()
        const numWorkers = cpuCores > 4 ? 4 : Math.round(cpuCores/1.5)
        utils.debug(`Detected ${cpuCores} CPU cores, starting ${numWorkers} live stream ${numWorkers > 1 ? 'workers' : 'worker'}`)

        for (let i = 0; i < numWorkers; i++) {
            this.streamWorkers[i] = {
                liveCall: new Worker('./lib/livecall.js'),
                sessions: {}
            }

            this.streamWorkers[i].liveCall.on('message', (data) => {
                const deviceId = data.liveCallData.deviceId
                const workerId = this.getWorkerId(deviceId)
                if (workerId >= 0) {
                    switch (data.state) {
                        case 'active':
                            utils.event.emit(`livestream_${deviceId}`, 'active')
                            this.streamWorkers[workerId].sessions[deviceId].streamData.sessionId = data.liveCallData.sessionId
                            break;
                        case 'inactive':
                            utils.event.emit(`livestream_${deviceId}`, 'inactive')
                            delete this.streamWorkers[workerId].sessions[deviceId]
                            break;
                        case 'failed':
                            utils.event.emit(`livestream_${deviceId}`, 'failed')
                            delete this.streamWorkers[workerId].sessions[deviceId]
                            break;
                    }
                }
            })
        }

        utils.event.on('start_livestream', (streamData) => {
            if (this.getWorkerId(streamData.deviceId) < 0) {
                // Create an array with the number of active sessions per worker
                const workerSessions = this.streamWorkers.map(worker => Object.keys(worker.sessions).length)
                // Find the fewest number of active sessions for any worker
                const fewestSessions = Math.min(...workerSessions)
                // Find index of first worker that matches the fewest active sessions
                const workerId = workerSessions.indexOf(fewestSessions)
                utils.debug(colors.green(`[${streamData.deviceName}] `)+`Live stream assigned to worker ${parseInt(workerId)+1} with ${fewestSessions} current active ${fewestSessions === 1 ? 'session' : 'sessions'}`)
                this.streamWorkers[workerId].sessions[streamData.deviceId] = { streamData }
                this.streamWorkers[workerId].liveCall.postMessage({ command: 'start', streamData })
            }
        })

        utils.event.on('stop_livestream', (streamData) => {
            const workerId = this.getWorkerId(streamData.deviceId)
            if (workerId >= 0) {
                utils.debug(colors.green(`[${streamData.deviceName}] `)+`Stopping live stream session on workerId ${parseInt(workerId)+1}`)
                this.streamWorkers[workerId].liveCall.postMessage({ command: 'stop', streamData: this.streamWorkers[workerId].sessions[streamData.deviceId].streamData })
            } else {
                utils.debug(colors.green(`[${streamData.deviceName}] `)+'Received live stream stop command but no active session was found')
                // If stop received but no session found, force send inactive state
                utils.event.emit(`livestream_${streamData.deviceId}`, 'inactive')
            }
        })
    }

    getWorkerId(deviceId) {
        return this.streamWorkers.findIndex(worker => worker.sessions.hasOwnProperty(deviceId))
    }
 }

module.exports = new StreamWorkers()