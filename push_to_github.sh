#!/usr/bin/env bash
# push_to_github.sh — Link and Push to GitHub
cd "$(dirname "$0")"

echo "=================================================="
echo "  Link and Push to GitHub"
echo "=================================================="
echo ""
echo "Truoc tien, hay truy cap: https://github.com/new"
echo "Tao mot repository moi (nen de che do Private)."
echo "Copy duong dan HTTPS cua repo do (dang: https://github.com/username/repo.git)"
echo ""
read -rp "Nhap duong dan HTTPS cua repository: " repo_url

if [ -z "$repo_url" ]; then
    echo "[XX] Duong dan khong duoc de trong!"
    exit 1
fi

# Xoa remote origin cu neu co
git remote remove origin 2>/dev/null

# Them remote origin moi
git remote add origin "$repo_url"
echo "[OK] Da lien ket voi: $repo_url"

echo ""
echo "Dang day code len GitHub (chuan bi dang nhap neu duoc yeu cau)..."
git push -u origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "=================================================="
    echo "[OK] Day code len GitHub thanh cong!"
    echo ""
    echo "Gio ban co the vao Vercel (https://vercel.com) de"
    echo "import repository nay va deploy trong 30 giay."
    echo "=================================================="
else
    echo ""
    echo "[XX] That bai! Kiem tra lai quyen truy cap hoac tai khoan."
fi
