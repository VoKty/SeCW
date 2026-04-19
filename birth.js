const messages = [
    "时光荏苒，岁月如歌",
    "在这个特别的日子里",
    "愿所有的美好如期而至",
    "这个网站",
    "历时    天",
    "只为今日"
];

let currentIndex = 0;

function displayMessage() {
    const textContainer = document.getElementById('text-container');
    textContainer.textContent = messages[currentIndex];

    // 设置透明度为1（完全可见）
    textContainer.style.opacity = 1;

    // 1秒后开始淡出
    setTimeout(() => {
        // 设置透明度为0（完全透明）
        textContainer.style.opacity = 0;

        // 淡出完成后切换到下一条消息
        setTimeout(() => {
            currentIndex = (currentIndex + 1) % messages.length;
            displayMessage(); // 递归调用以显示下一条消息
        }, 1000); // 等待1秒（淡出动画时间）后再切换
    }, 1000); // 1秒后开始淡出
}
displayMessage()
