import type {DecodedImage} from './image-analysis';

export function imageSpecifications(image:Pick<DecodedImage,'width'|'height'|'bitDepth'|'channelCount'|'pixelSizeMicrons'>) {
 const calibration=image.pixelSizeMicrons;
 const calibrated=calibration&&calibration.length>=2&&calibration.slice(0,2).every(value=>Number.isFinite(value)&&value>0);
 const physicalSize=calibrated?`${(image.width*calibration[0]).toFixed(2)} × ${(image.height*calibration[1]).toFixed(2)} µm`:null;
 return {physicalSize,decodedMiB:image.width*image.height*image.channelCount*(image.bitDepth/8)/1024**2,
  summary:`${physicalSize?physicalSize+' · ':''}${image.width} × ${image.height} px · ${image.bitDepth}-bit source`};
}
