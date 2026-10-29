#!/bin/bash
set -e

# Start Virtual Framebuffer Xvfb on display :99
echo "⚡ Khởi động màn hình ảo Xvfb (:99)..."
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp &
export DISPLAY=:99

# Wait for Xvfb to initialize
sleep 1

echo "🚀 Thực thi lệnh: $@"
exec "$@"
