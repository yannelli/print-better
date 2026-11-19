// Safari runs this before the share sheet opens: it hands over the page as it is now, so it prints as seen.
var ExtensionPreprocessingJS = {
  run: function (args) {
    var page = document.documentElement.cloneNode(true)
    // The page already ran its scripts; running them again could change or blank it.
    page.querySelectorAll('script, noscript').forEach(function (node) {
      node.remove()
    })
    page.querySelectorAll('img[loading="lazy"]').forEach(function (img) {
      img.removeAttribute('loading')
    })
    args.completionFunction({ url: document.URL, title: document.title, html: '<!DOCTYPE html>' + page.outerHTML })
  },
  finalize: function () {},
}
