// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront invokes this global entry point by name.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var finalSegment = uri.substring(uri.lastIndexOf("/") + 1);
  var isApi = uri === "/api" || uri.indexOf("/api/") === 0;
  var isAuth = uri === "/auth" || uri.indexOf("/auth/") === 0;
  if (!isApi && !isAuth && finalSegment.indexOf(".") === -1) {
    request.uri = "/index.html";
  }
  return request;
}
