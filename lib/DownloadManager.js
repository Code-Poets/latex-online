var exec = require('child_process').execFile;
var fs = require('fs');
const dataUriRE = require('data-uri-regex');
var utils = require('./utilities');
var path = require('path');
var request = require('request');
var logger = utils.logger('Downloader');

var UserErrors = {
    LoadingBadResponse: (url, statusCode) => `failed to download URL ${url} - got response status ${statusCode}`,
    LoadingError: (url, error) => `error while loading ${url}: ${error}`,
    GitCloneFailed: (url) => `failed to clone git repository ${url}`,
    TarballExtractionFailed: () => `failed to extract tarball`,
    ImageDataUrlExtractionFailed: (imgName) => `failed to save image ${imgName} -- expected image data URI`,
}

class DownloadManager {
    /**
     * @return {!Promise<?DownloadManager>}
     */
    static async create(folderPath) {
        var success = await utils.recreateFolderIfNonEmpty(folderPath);
        if (!success) {
            logger.error("ERROR: failed to create folder for Downloader - " + folderPath);
            return null;
        }
        return new DownloadManager(folderPath);
    }

    /**
     * @param {string} folderPath
     */
    constructor(folderPath) {
        this._folderPath = folderPath;
        this._id = 0;
    }

    /**
     * @return {string}
     */
    folderPath() {
        return this._folderPath;
    }

    /**
     * @return {string}
     */
    _nextName() {
        var id = ++this._id;
        return path.join(this._folderPath, 'tmp_' + id);
    }

    /**
     * @param {string} text
     * @param {string} fileName
     * @return {!Downloader}
     */
    createTextDownloader(text, fileName) {
        var folderPath = this._nextName();
        return new Downloader(async () => {
            logger.info(`Creating text file ${fileName} with ${text.length} bytes`);
            var success = await createFolder(folderPath);
            if (!success)
                return new DownloadResult(null, null);
            var filePath = path.join(folderPath, fileName);
            var fileCreated = await utils.writeFile(filePath, text);
            if (!fileCreated) {
                logger.error(`ERROR: Downloader failed to write ${text.length} bytes of text into file ${filePath}`);
                utils.rmdir(folderPath);
                return new DownloadResult(null, null);
            }
            return new DownloadResult(folderPath, null);
        });
    }

    /**
     * @param {string} url
     * @return {!Downloader}
     */
    createGitDownloader(url) {
        var folderPath = this._nextName();
        return new Downloader(async () => {
            var exists = await utils.exists(folderPath);
            if (exists) {
                logger.error(`ERROR: Downloader hit a conflict - directory ${folderPath} already exists`);
                return new DownloadResult(null, null);
            }
            var fulfill;
            var promise = new Promise(x => fulfill = x);
            logger.info(`git clone ${url} ${folderPath}`);
            exec('git', ['clone', '--depth', '1', url, folderPath], {timeout: utils.minutes(2)}, (err, stdout, stderr) => {
                if (err) {
                    logger.error(`ERROR: Downloader failed to clone git repository. ${err.message}`);
                    fulfill(new DownloadResult(null, UserErrors.GitCloneFailed(url)));
                    return;
                }
                fulfill(new DownloadResult(folderPath, null));
            });
            return promise;
        });
    }

    /**
     * @param {string} url
     * @param {string} fileName
     * @return {!Downloader}
     */
    createURLDownloader(url, fileName) {
        var folderPath = this._nextName();
        return new Downloader(async () => {
            var success = await createFolder(folderPath);
            if (!success)
                return new DownloadResult(null, null);
            var filePath = path.join(folderPath, fileName);
            var fileHandle = fs.createWriteStream(filePath);

            var fulfill;
            var promise = new Promise(x => fulfill = x);

            logger.info(`wget ${url} > ${filePath}`);
            request.get(url, {timeout:5000})
                .on('response', function(response) {
                    if (response.statusCode < 200 || response.statusCode >= 400) {
                        var error = UserErrors.LoadingBadResponse(url, response.statusCode);
                        logger.info(`INFO: Downloader tried to load ${url} and got response status ${response.statusCode}`);
                        fulfill(new DownloadResult(null, error));
                    }
                })
                .on('error', function(err) {
                    utils.rmdirRecursive(folderPath);
                    var error = UserErrors.LoadingError(url, err);
                    logger.info(`INFO: Downloader tried to load ${url} and got error - ${err}`);
                    fulfill(new DownloadResult(null, error));
                })
                .pipe(fileHandle);

            fileHandle
                .on('finish', () => {
                    fulfill(new DownloadResult(folderPath, null));
                });
            return promise;
        });
    }

    /**
     * @param {string} tarballPath
     * @return {!Downloader}
     */
    createTarballExtractor(tarballPath) {
        var folderPath = this._nextName();
        return new Downloader(async () => {
            var success = await createFolder(folderPath);
            if (!success)
                return new DownloadResult(null, null);
            var fulfill;
            var promise = new Promise(x => fulfill = x);
            logger.info(`tar -xf ${tarballPath} -C ${folderPath}`);
            exec('tar', ['-xf', tarballPath, '-C', folderPath], (err, stdout, stderr) => {
                if (err) {
                    utils.rmdirRecursive(folderPath);
                    logger.error(`ERROR: Downloader failed to extract tarball. ${err.message}`);
                    fulfill(new DownloadResult(null, UserErrors.TarballExtractionFailed()));
                    return;
                }
                fulfill(new DownloadResult(folderPath, null));
            });
            return promise;
        });
    }

  /**
   * Create a downloader from json data. Expected JSON string with the following structure
   *  {
   *    text: string;
   *    images: {
   *      name: string;
   *      imageDataUrl: string
   *      } [];
   *  }
   * where:
   *  text is a TeX (latex) template of document with images referred with names
   *  images is an array of images where each item consists of image name as used in TeX template and an imageDataUrl
   *  with image content
   * @param {object} jsonData
   * @param {string} fileName
   * @return {!Downloader}
   */
  createJsonDownloader(jsonData, fileName) {
    var folderPath = this._nextName();
    return new Downloader(async () => {
      logger.info(`createJsonDownloader: Creating text file ${fileName} of size ${jsonData.text.length}b`);
      logger.info(`createJsonDownloader: File content is\n${jsonData.text}`);
      var success = await createFolder(folderPath);
      if (!success) {
        logger.error(`createJsonDownloader error: Unable to create temporary folder '${folderPath}'`);
        return new DownloadResult(null, null);
      }
      var filePath = path.join(folderPath, fileName);
      var fileCreated = await utils.writeFile(filePath, jsonData.text);
      if (!fileCreated) {
        logger.error(`createJsonDownloader error: Failed to create file '${filePath}' of size ${jsonData.text.length}B`);
        utils.rmdir(folderPath);
        return new DownloadResult(null, null);
      }

      var downloadedImageDataTotal = 0;
      for(const img of jsonData.images) {

        logger.info(`createJsonDownloader: Processing '${img.name}'/~${(img.imageDataUrl.length / 1024).toPrecision(2)}kB`);
        // logger.info(`createJsonDownloader: dataURI content: ${img.imageDataUrl}`);
        const imgData = dataUriRE().exec(img.imageDataUrl);

        if (!imgData) {

          utils.rmdirRecursive(folderPath);
          var error = UserErrors.ImageDataUrlExtractionFailed(img.name);
          logger.info(`createJsonDownloader error: ${error}`);
          return new DownloadResult(null, error);

        } else {
          // logger.info(`createJsonDownloader: ${'\n' + imgData[3] + '\n' + imgData[4]}`);

          // FIXME: Add validation of content mime type and file extension to enforce robust client code.
          // const mime = require('mime');
          // const extension = mime.extension(imgData[2])

          var filePath = path.join(folderPath, img.name);
          var fileCreated = await utils.writeFile(filePath, new Buffer(imgData[4], imgData[3]));
          if (!fileCreated) {
            logger.error(`createJsonDownloader error: Failed to create file '${img.name}'`
                         + ` of size ${imgData[4].length / 1024}kB`);
            utils.rmdirRecursive(folderPath);
            return new DownloadResult(null, null);
          }

          downloadedImageDataTotal += imgData[4].length;
          logger.info(`createJsonDownloader: Done image '${img.name}'/${(imgData[4].length / 1024).toPrecision(2)}kB`);
        }
      }
      logger.info(`createJsonDownloader: Downloaded '${jsonData.images.length}' images of total` +
                  ` size ${(downloadedImageDataTotal / 1024).toPrecision(2)}kB`);

      // If the image contains inkscape processing options apply them to the file before proceeding with latex.
      // For security reasons only a subset of options is allowed. They should be passed as an object where
      // keys have the same names as inkscape options (long name versions, so export-png instead just e)
      // and the value should represent expected option parameter if any. For example:
      // inkscape: {'export-png': 'file.png', 'export-area': {x0: 0, y0: 0, x1: 100, y1: 200}
      logger.info('createJsonDownloader: Applying inkscape convolutions to images (if any)');

      const supportedInkscapeOptions = {
        'export-png': function(pngFileName) {
          if (typeof(pngFileName) !== 'string') { throw 'File name expected.'; }
          return `--export-png=${folderPath +'/' + pngFileName}`;
        },
        'export-area': function(area) {
          var x0, y0, x1, y1;
          try {
            x0 = parseInt(area.x0);
            y0 = parseInt(area.y0);
            x1 = parseInt(area.x1);
            y1 = parseInt(area.y1);
          } catch (err) {
            throw 'Four numbers x0, y0, x1, y1 expected as parameters.'
          }
          if (isNaN(x0) || isNaN(y0) || isNaN(x1) || isNaN(y1)) {
            throw 'Four numbers x0, y0, x1, y1 expected as parameters but NaN detected';
          }
          return `--export-area=${x0}:${y0}:${x1}:${y1}`;

        },
        'export-width': function(width) {
          var w;
          try { w = parseInt(width); } catch (err) {
            throw 'Expected a number parameter.';
          }
          if (isNaN(w)) {
            throw 'Expected a number parameter but NaN detected.';
          }
          return `--export-width=${w}`;
        },
        'export-height': function(height) {
          var h;
          try { h = parseInt(height); } catch (err) {
            throw 'Expected a number parameter.';
          }
          if (isNaN(h)) {
            throw 'Expected a number parameter but NaN detected.';
          }
          return `--export-height=${h}`;
        },
      };

      var inkscapeConvolutedImages = 0;
      for(const img of jsonData.images) {
        if (img.inkscape) {
          const imgPath = path.join(folderPath, img.name);
          const jsonInkscapeOptions = [];
          for(const option of Object.keys(img.inkscape)) {
            try {
              jsonInkscapeOptions.push(supportedInkscapeOptions[option](img.inkscape[option]));
            } catch(err) {
              logger.error(
                `createJsonDownloader error: Unable to execute inkscape for ${img.name}. ` +
                `Option '${option}' has an error: ${err}`
              );
              return new DownloadResult(null, null);
            }
          }

          const options = ['--without-gui', `--file=${imgPath}`];
          success = await utils.executeCommand('/usr/bin/inkscape', options.concat(jsonInkscapeOptions));
          if (!success) {
             logger.error(`createJsonDownloader error: Unable to execute inkscape for '${img.name}'`);
             return new DownloadResult(null, null);
          } else {
            logger.info(`createJsonDownloader: Executed ${"/usr/bin/inkscape " + options.concat(jsonInkscapeOptions).join()}`);
            inkscapeConvolutedImages += 1;
          }
        }
      }
      logger.info(`createJsonDownloader: ${inkscapeConvolutedImages} image(s) successfully converted with inkscape.`);

      return new DownloadResult(folderPath, null);
    });
  }
}

class Downloader {
    /**
     * @param {function()} downloadJob
     */
    constructor(downloadJob) {
        this.folderPath = null;
        this.userError = null;
        this._disposed = false;
        this._downloadJob = downloadJob;
    }

    /**
     * @return {!Promise}
     */
    downloadIfNeeded() {
        if (this._downloadPromise)
            return this._downloadPromise;
        this._downloadPromise = this._downloadJob.call(null).then(result => {
            this.folderPath = result.folderPath;
            this.userError = result.userError;
            logger.info('Downloading finished', {userError: this.userError, folderPath: this.folderPath});
            return this;
        });
        return this._downloadPromise;
    }

    dispose() {
        if (this._disposed)
            return;
        this._disposed = true;
        logger.info(`Cleaning up ${this.folderPath}`);
        if (this._dislabedCleanup) {
            logger.warn('WARN: cleanup ignored for ' + this.folderPath);
            return;
        }
        if (!this.folderPath) {
            logger.warn('Downloader failed to create folder - nothing to cleanup');
            return;
        }
        utils.rmdirRecursive(this.folderPath).then(success => {
            if (!success)
                logger.error('ERROR: downloader failed to remove temp folder.');
            else
                logger.info('Downloader removed folder ' + this.folderPath);
        });
    }
}

/**
 * @return {!Promise<?string>}
 */
async function createFolder(folderPath) {
    var success = await utils.mkdir(folderPath);
    if (!success)
        logger.error(`ERROR: Downloader failed to create temporary directory ${folderPath}`);
    return success;
}

class DownloadResult {
    /**
     * @param {?string} folderPath
     * @param {?string} userError
     */
    constructor(folderPath, userError) {
        this.folderPath = folderPath;
        this.userError = userError;
    }
}

module.exports = DownloadManager;
