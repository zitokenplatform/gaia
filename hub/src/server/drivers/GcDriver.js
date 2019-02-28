/* @flow */

import { Storage } from '@google-cloud/storage'
import logger from 'winston'

import { BadPathError } from '../errors'
import type { ListFilesResult, PerformWriteArgs } from '../driverModel'
import { DriverStatics, DriverModel } from '../driverModel'
import { promisify } from 'util'

//$FlowFixMe - Flow is unaware of the stream.pipeline Node API
import { pipeline } from 'stream'

const pipelinePromise = promisify(pipeline)

type GC_CONFIG_TYPE = { gcCredentials?: {
                          email?: string,
                          projectId?: string,
                          keyFilename?: string,
                          credentials?: {
                            client_email?: string,
                            private_key?: string
                          }
                        },
                        cacheControl?: string,
                        pageSize?: number,
                        bucket: string,
                        resumable?: boolean }

class GcDriver implements DriverModel {
  bucket: string
  storage: Storage
  pageSize: number
  cacheControl: ?string
  initPromise: Promise<void>
  resumable: boolean

  static getConfigInformation() {
    const envVars = {}
    const gcCredentials = {}
    if (process.env['GAIA_GCP_EMAIL']) {
      gcCredentials['email'] = process.env['GAIA_GCP_EMAIL']
      envVars['gcCredentials'] = gcCredentials
    }
    if (process.env['GAIA_GCP_PROJECT_ID']) {
      gcCredentials['projectId'] = process.env['GAIA_GCP_PROJECT_ID']
      envVars['gcCredentials'] = gcCredentials
    }
    if (process.env['GAIA_GCP_KEY_FILENAME']) {
      gcCredentials['keyFilename'] = process.env['GAIA_GCP_KEY_FILENAME']
      envVars['gcCredentials'] = gcCredentials
    }
    if (process.env['GAIA_GCP_CLIENT_EMAIL']) {
      gcCredentials['credentials'] = {}
      gcCredentials['credentials']['client_email'] = process.env['GAIA_GCP_CLIENT_EMAIL']
      if (process.env['GAIA_GCP_CLIENT_PRIVATE_KEY']) {
        gcCredentials['credentials']['private_key'] = process.env['GAIA_GCP_CLIENT_PRIVATE_KEY']
      }
      envVars['gcCredentials'] = gcCredentials
    }

    return {
      defaults: { gcCredentials: {} },
      envVars
    }
  }


  constructor (config: GC_CONFIG_TYPE) {
    this.storage =  new Storage(config.gcCredentials)
    this.bucket = config.bucket
    this.pageSize = config.pageSize ? config.pageSize : 100
    this.cacheControl = config.cacheControl
    this.initPromise = this.createIfNeeded()
    this.resumable = config.resumable || false
  }

  ensureInitialized() {
    return this.initPromise
  }

  dispose() {
    return Promise.resolve()
  }

  static isPathValid(path: string){
    // for now, only disallow double dots.
    return (path.indexOf('..') === -1)
  }

  getReadURLPrefix () {
    return `https://storage.googleapis.com/${this.bucket}/`
  }

  createIfNeeded() {
    const bucket = this.storage.bucket(this.bucket)

    return bucket.exists()
    .then(data => {
      const exists = data[0]
      if (!exists) {
        return this.storage
          .createBucket(this.bucket)
          .then(() => {
            logger.info(`initialized google cloud storage bucket: ${this.bucket}`)
          })
          .catch(err => {
            logger.error(`failed to initialize google cloud storage bucket: ${err}`)
            process.exit()
            throw err
          })
      }
    })
    .catch(err => {
      logger.error(`failed to connect to google cloud storage bucket: ${err}`)
      process.exit()
      throw err
    })
  }

  listAllObjects(prefix: string, page: ?string) : Promise<ListFilesResult> {
    // returns {'entries': [...], 'page': next_page}
    const opts : { prefix: string, maxResults: number, pageToken?: string } = {
      prefix: prefix,
      maxResults: this.pageSize
    }
    if (page) {
      opts.pageToken = page
    }
    return new Promise((resolve, reject) => {
      return this.storage.bucket(this.bucket).getFiles(opts, (err, files, nextQuery) => {
        if (err) {
          return reject(err)
        }
        const fileNames = []
        files.forEach(file => {
          fileNames.push(file.name.slice(prefix.length + 1))
        })
        const ret : ListFilesResult = {
          entries: fileNames,
          page: null
        }
        if (nextQuery && nextQuery.pageToken) {
          ret.page = nextQuery.pageToken
        }
        return resolve(ret)
      })
    })
  }

  listFiles(prefix: string, page: ?string) {
    // returns {'entries': [...], 'page': next_page}
    return this.listAllObjects(prefix, page)
  }

  async performWrite(args: PerformWriteArgs) : Promise<string> {
    if (!GcDriver.isPathValid(args.path)) {
      throw new BadPathError('Invalid Path')
    }

    const filename = `${args.storageTopLevel}/${args.path}`
    const publicURL = `${this.getReadURLPrefix()}${filename}`

    const metadata = {}
    metadata.contentType = args.contentType
    if (this.cacheControl) {
      metadata.cacheControl = this.cacheControl
    }

    const fileDestination = this.storage
      .bucket(this.bucket)
      .file(filename)

    const fileWriteStream = fileDestination.createWriteStream({
      public: true,
      resumable: this.resumable,
      metadata
    })

    try {
      await pipelinePromise(args.stream, fileWriteStream)
      logger.debug(`storing ${filename} in bucket ${this.bucket}`)
    } catch (error) {
      logger.error(`failed to store ${filename} in bucket ${this.bucket}`)
      throw new Error('Google cloud storage failure: failed to store' +
        ` ${filename} in bucket ${this.bucket}: ${error}`)
    }

    return publicURL
  }
}

(GcDriver: DriverStatics)

export default GcDriver
