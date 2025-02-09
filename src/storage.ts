import createError from 'http-errors';

import { UploadTarball, ReadTarball } from '@verdaccio/streams';
import { HttpError } from 'http-errors';
import { Package, Callback, Logger, IPackageStorageManager } from '@verdaccio/types';
import { VerdaccioConfigGoogleStorage } from './types';
import { Bucket, File } from '@google-cloud/storage';

export const noSuchFile = 'ENOENT';
export const fileExist = 'EEXISTS';
export const pkgFileName = 'package.json';
export const defaultValidation = 'crc32c';

declare type StorageType = Package | void;

export const fSError = function(message: string, code: number = 404): HttpError {
  const err: HttpError = createError(code, message);
  // $FlowFixMe
  err.code = message;

  return err;
};

const noPackageFoundError = function(message = 'no such package') {
  const err: HttpError = createError(404, message);
  // $FlowFixMe
  err.code = noSuchFile;

  return err;
};

const packageAlreadyExist = function(name: any, message = `${name} package already exist`) {
  const err: HttpError = createError(409, message);
  // $FlowFixMe
  err.code = fileExist;

  return err;
};

class GoogleCloudStorageHandler implements IPackageStorageManager {
  storage: any;
  path: string | undefined;
  logger: Logger;
  key: string;
  helper: any;
  name: string;
  config: VerdaccioConfigGoogleStorage;

  constructor(name: string, storage: any, datastore: any, helper: any, config: VerdaccioConfigGoogleStorage, logger: Logger) {
    this.name = name;
    this.storage = storage;
    this.logger = logger;
    this.helper = helper;
    this.config = config;
    this.key = 'VerdaccioMetadataStore';
  }

  updatePackage(name: string, updateHandler: Callback, onWrite: Callback, transformPackage: Function, onEnd: Callback): void {
    this._readPackage(name)
      .then(
        metadata => {
          updateHandler(metadata, (err: any) => {
            if (err) {
              this.logger.error({ name: name, err: err.message }, 'gcloud: on write update @{name} package has failed err: @{err}');
              return onEnd(err);
            }
            try {
              onWrite(name, transformPackage(metadata), onEnd);
            } catch (err) {
              this.logger.error({ name: name, err: err.message }, 'gcloud: on write update @{name} package has failed err: @{err}');
              return onEnd(fSError(err.message, 500));
            }
          });
        },
        err => {
          this.logger.error({ name: name, err: err.message }, 'gcloud: update @{name} package has failed err: @{err}');
          onEnd(fSError(err.message, 500));
        }
      )
      .catch(() => {
        this.logger.error({ name: name }, 'gcloud: trying to update @{name} and was not found on storage');
        return onEnd(noPackageFoundError());
      });
  }

  deletePackage(fileName: string, cb: Callback): void {
    const file = this._buildFilePath(this.name, fileName);
    this.logger.debug({ name: file.name }, 'gcloud: deleting @{name} from storage');
    try {
      file
        .delete()
        .then((data: any) => {
          const apiResponse = data[0];
          this.logger.debug({ name: file.name }, 'gcloud: @{name} was deleted successfully from storage');
          cb(null, apiResponse);
        })
        .catch((err: any) => {
          this.logger.error({ name: file.name, err: err.message }, 'gcloud: delete @{name} file has failed err: @{err}');
          cb(fSError(err.message, 500));
        });
    } catch (err) {
      this.logger.error({ name: file.name, err: err.message }, 'gcloud: delete @{name} file has failed err: @{err}');
      cb(fSError('something went wrong', 500));
    }
  }

  removePackage(callback: Callback): void {
    // remove all files from storage
    const file = this._getBucket().file(`${this.name}`);
    this.logger.debug({ name: file.name }, 'gcloud: removing the package @{name} from storage');
    file.delete().then(
      () => {
        this.logger.debug({ name: file.name }, 'gcloud: package @{name} was deleted successfully from storage');
        callback(null);
      },
      (err: any) => {
        this.logger.error({ name: file.name, err: err.message }, 'gcloud: delete @{name} package has failed err: @{err}');
        callback(fSError(err.message, 500));
      }
    );
  }

  createPackage(name: string, metadata: Object, cb: Function): void {
    this.logger.debug({ name }, 'gcloud: creating new package for @{name}');
    this._fileExist(name, pkgFileName).then(
      exist => {
        if (exist) {
          this.logger.debug({ name }, 'gcloud: creating @{name} has failed, it already exist');
          cb(packageAlreadyExist(name));
        } else {
          this.logger.debug({ name }, 'gcloud: creating @{name} on storage');
          this.savePackage(name, metadata, cb);
        }
      },
      err => {
        this.logger.error({ name: name, err: err.message }, 'gcloud: create package @{name} has failed err: @{err}');
        cb(fSError(err.message, 500));
      }
    );
  }

  savePackage(name: string, value: Object, cb: Function): void {
    this.logger.debug({ name }, 'gcloud: saving package for @{name}');
    this._savePackage(name, value)
      .then(() => {
        this.logger.debug({ name }, 'gcloud: @{name} has been saved successfully on storage');
        cb(null);
      })
      .catch(err => {
        this.logger.error({ name: name, err: err.message }, 'gcloud: save package @{name} has failed err: @{err}');
        return cb(err);
      });
  }

  _savePackage(name: string, metadata: Object): Promise<any> {
    return new Promise(async (resolve, reject) => {
      const file = this._buildFilePath(name, pkgFileName);
      try {
        await file.save(this._convertToString(metadata), {
          validation: this.config.validation || defaultValidation,
          /**
           * When resumable is `undefined` - it will default to `true`as per GC Storage documentation:
           * `Resumable uploads are automatically enabled and must be shut off explicitly by setting options.resumable to false`
           * @see https://cloud.google.com/nodejs/docs/reference/storage/2.5.x/File#createWriteStream
           */
          resumable: this.config.resumable
        });
        resolve(null);
      } catch (err) {
        reject(fSError(err.message, 500));
      }
    });
  }

  _convertToString(value: any): string {
    return JSON.stringify(value, null, '\t');
  }

  readPackage(name: string, cb: Function): void {
    this.logger.debug({ name }, 'gcloud: reading package for @{name}');
    this._readPackage(name)
      .then(json => {
        this.logger.debug({ name }, 'gcloud: package @{name} was fetched from storage');
        cb(null, json);
      })
      .catch(err => {
        this.logger.debug({ name: name, err: err.message }, 'gcloud: read package @{name} has failed err: @{err}');
        cb(err);
      });
  }

  _buildFilePath(name: string, fileName: string): File {
    return this._getBucket().file(`${name}/${fileName}`);
  }

  _fileExist(name: string, fileName: string) {
    return new Promise(async (resolve, reject) => {
      const file = this._buildFilePath(name, fileName);
      try {
        const data = await file.exists();
        const exist = data[0];

        resolve(exist);
        this.logger.debug({ name: name, exist }, 'gcloud: check whether @{name} exist successfully: @{exist}');
      } catch (err) {
        this.logger.error({ name: file.name, err: err.message }, 'gcloud: check exist package @{name} has failed, cause: @{err}');
        reject(fSError(err.message, 500));
      }
    });
  }

  async _readPackage(name: string): Promise<any> {
    return new Promise(async (resolve, reject) => {
      const file = this._buildFilePath(name, pkgFileName);
      try {
        const content = await file.download();
        this.logger.debug({ name: this.name }, 'gcloud: @{name} was found on storage');
        resolve(JSON.parse(content[0].toString('utf8')));
      } catch (err) {
        this.logger.debug({ name: this.name }, 'gcloud: @{name} package not found on storage');
        reject(noPackageFoundError());
      }
    });
  }

  writeTarball(name: string): UploadTarball {
    const uploadStream: UploadTarball = new UploadTarball({});

    try {
      this._fileExist(this.name, name).then(
        exist => {
          if (exist) {
            this.logger.debug({ url: this.name }, 'gcloud:  @{url} package already exist on storage');
            uploadStream.emit('error', packageAlreadyExist(name));
          } else {
            const file = this._getBucket().file(`${this.name}/${name}`);
            this.logger.info({ url: file.name }, 'gcloud: the @{url} is being uploaded to the storage');
            const fileStream = file.createWriteStream({
              validation: this.config.validation || defaultValidation
            });
            uploadStream.done = () => {
              uploadStream.on('end', () => {
                fileStream.on('response', () => {
                  this.logger.debug({ url: file.name }, 'gcloud: @{url} has been successfully uploaded to the storage');
                  uploadStream.emit('success');
                });
              });
            };

            fileStream._destroy = function(err) {
              // this is an error when user is not authenticated
              // [BadRequestError: Could not authenticate request
              //  getaddrinfo ENOTFOUND www.googleapis.com www.googleapis.com:443]
              if (err) {
                uploadStream.emit('error', fSError(err.message, 400));
                fileStream.emit('close');
              }
            };

            fileStream.on('open', () => {
              this.logger.debug({ url: file.name }, 'gcloud: upload streem has been opened for @{url}');
              uploadStream.emit('open');
            });

            fileStream.on('error', (err: any) => {
              this.logger.error({ url: file.name }, 'gcloud: upload stream has failed for @{url}');
              fileStream.end();
              uploadStream.emit('error', fSError(err, 400));
            });

            uploadStream.abort = () => {
              this.logger.warn({ url: file.name }, 'gcloud: upload stream has been aborted for @{url}');
              fileStream.destroy(undefined);
            };

            uploadStream.pipe(fileStream);
            uploadStream.emit('open');
          }
        },
        err => {
          uploadStream.emit('error', fSError(err.message, 500));
        }
      );
    } catch (err) {
      uploadStream.emit('error', err);
    }
    return uploadStream;
  }

  readTarball(name: string): ReadTarball {
    const readTarballStream: ReadTarball = new ReadTarball({});
    const file = this._getBucket().file(`${this.name}/${name}`);
    const fileStream = file.createReadStream();
    this.logger.debug({ url: file.name }, 'gcloud: reading tarball from @{url}');

    readTarballStream.abort = function() {
      fileStream.destroy(undefined);
    };

    fileStream
      .on('error', (err: any) => {
        if (err.code === 404) {
          this.logger.debug({ url: file.name }, 'gcloud: tarball @{url} do not found on storage');
          readTarballStream.emit('error', noPackageFoundError());
        } else {
          this.logger.error({ url: file.name }, 'gcloud: tarball @{url} has failed to be retrieved from storage');
          readTarballStream.emit('error', fSError(err.message, 400));
        }
      })
      .on('response', response => {
        const size = response.headers['content-length'];
        const { statusCode } = response;
        if (statusCode !== 404) {
          if (size) {
            readTarballStream.emit('open');
          }

          if (parseInt(size, 10) === 0) {
            this.logger.error({ url: file.name }, 'gcloud: tarball @{url} was fetched from storage and it is empty');
            readTarballStream.emit('error', fSError('file content empty', 500));
          } else if (parseInt(size, 10) > 0 && statusCode === 200) {
            readTarballStream.emit('content-length', response.headers['content-length']);
          }
        } else {
          this.logger.debug({ url: file.name }, 'gcloud: tarball @{url} do not found on storage');
          readTarballStream.emit('error', noPackageFoundError());
        }
      })
      .pipe(readTarballStream);
    return readTarballStream;
  }

  _getBucket(): Bucket {
    return this.storage.bucket(this.config.bucket);
  }
}

export default GoogleCloudStorageHandler;
