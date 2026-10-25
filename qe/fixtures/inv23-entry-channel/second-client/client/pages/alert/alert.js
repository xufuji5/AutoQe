// 第二个客户端（小程序）的页面：扩展名是 .js，发请求走 wx.request
Page({
  onTap() {
    wx.request({ url: '/api/urgent', method: 'POST', data: { level: 1 } })
  },
})
