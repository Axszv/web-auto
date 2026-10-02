#!/usr/bin/env python3
# lib/captcha_ocr.py — 用 ddddocr 识别验证码图片
# 用法: python captcha_ocr.py <image_path>   → 输出识别文本到 stdout
import sys


def main():
    if len(sys.argv) < 2:
        print("", end="")
        return
    img_path = sys.argv[1]
    try:
        import ddddocr
        ocr = ddddocr.DdddOcr(show_ad=False)
        with open(img_path, "rb") as f:
            img = f.read()
        result = ocr.classification(img)
        # 清理：只保留字母数字，转小写（站点验证码是 4 位小写字母+数字）
        import re
        result = re.sub(r"[^a-zA-Z0-9]", "", result)
        # 验证码固定 length=4，取前 4 位
        result = result[:4].lower()
        print(result, end="")
    except Exception as e:
        # 失败时输出空，由调用方重试
        print("", end="")


if __name__ == "__main__":
    main()