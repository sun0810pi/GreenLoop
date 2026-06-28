# Deploy GreenLoop ngoài Vercel

## Cách nhanh nhất để có URL cho giám khảo: Render

Nếu mục tiêu là có một link HTTPS để giám khảo mở ngay, dùng Render là nhanh nhất với repo hiện tại.

Sau khi push code lên GitHub:

1. Vào [Render Dashboard](https://dashboard.render.com/).
2. Chọn **New** → **Blueprint**.
3. Kết nối repo GreenLoop.
4. Render sẽ tự đọc file `render.yaml` ở thư mục gốc.
5. Bấm **Deploy Blueprint**.
6. Khi deploy xong, Render sẽ cấp URL dạng:

```text
https://greenloop.onrender.com
```

Gửi URL đó cho giám khảo là mở được app.

### Lưu ý khi dùng Render Free

- Lần mở đầu tiên có thể chậm vì free service có thể ngủ sau một thời gian không ai truy cập.
- Dữ liệu demo lưu bằng file local có thể không bền vững như VPS/volume. Với mục tiêu chấm demo thì vẫn ổn; nếu chạy thật lâu dài thì dùng VPS/Docker ở phần dưới.

Khuyến nghị ổn định nhất cho dự án hiện tại là chạy **một Node server riêng**. Backend Express sẽ serve luôn `index.html`, nên không cần Vercel cho frontend.

## Vì sao chọn VPS/Docker

- Không phụ thuộc token Vercel hoặc tài khoản của người khác.
- Frontend và backend chạy cùng domain, tránh lỗi CORS/API URL.
- Database local `greenloop.db.json` được lưu trong Docker volume, không mất khi restart container.
- Có thể chuyển sang server khác bằng cách copy source + volume backup.

## Deploy nhanh bằng Docker Compose

Trên VPS Ubuntu:

```bash
sudo apt update
sudo apt install -y git docker.io docker-compose-plugin
sudo systemctl enable --now docker
```

Clone project:

```bash
git clone <repo-url> GreenLoop
cd GreenLoop
```

Tạo file `.env` ở thư mục gốc:

```bash
JWT_SECRET=doi-chuoi-bi-mat-that-dai-o-day
CORS_ORIGIN=
```

Chạy app:

```bash
docker compose up -d --build
```

Kiểm tra:

```bash
curl http://localhost:3000/health
```

App sẽ chạy ở:

```text
http://<IP-server>:3000
```

## Gắn domain bằng Nginx

Ví dụ domain là `greenloop.example.com`.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Tạo file:

```bash
sudo nano /etc/nginx/sites-available/greenloop
```

Nội dung:

```nginx
server {
    server_name greenloop.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Bật site:

```bash
sudo ln -s /etc/nginx/sites-available/greenloop /etc/nginx/sites-enabled/greenloop
sudo nginx -t
sudo systemctl reload nginx
```

Cài HTTPS:

```bash
sudo certbot --nginx -d greenloop.example.com
```

## Update phiên bản mới

```bash
git pull
docker compose up -d --build
```

## Backup dữ liệu

Database nằm trong Docker volume `greenloop-data`.

Backup:

```bash
docker run --rm -v greenloop-data:/data -v "$PWD":/backup alpine tar czf /backup/greenloop-data-backup.tar.gz -C /data .
```

Restore:

```bash
docker run --rm -v greenloop-data:/data -v "$PWD":/backup alpine sh -c "cd /data && tar xzf /backup/greenloop-data-backup.tar.gz"
```

## Biến môi trường quan trọng

| Biến | Ý nghĩa |
| --- | --- |
| `PORT` | Port Node server, mặc định `3000` |
| `JWT_SECRET` | Secret ký JWT, bắt buộc đổi khi production |
| `DB_PATH` | Đường dẫn file DB, Docker dùng `/data/greenloop.db.json` |
| `CORS_ORIGIN` | Chỉ cần set nếu frontend/backend tách domain |

## Ghi chú

Nếu app chạy chung domain như hướng dẫn này, `index.html` dùng API relative (`const API = ''`), nên không còn phụ thuộc Railway/Vercel.
