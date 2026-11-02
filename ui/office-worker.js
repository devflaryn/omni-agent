// The office's 3D pass off the main thread (it takes a second or more): see createOffice() in office.js.
import { renderOffice } from "./office.js";

self.onmessage = ({ data: { key, data } }) => {
  const { base, layout } = renderOffice(data);
  const { w, h, rgba, view } = base;
  self.postMessage({ key, layout, base: { w, h, rgba, view } }, [rgba.buffer]);
};
