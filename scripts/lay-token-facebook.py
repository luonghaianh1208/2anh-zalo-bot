"""Lấy Page Access Token vĩnh viễn của Facebook — làm thay bước 3, 4, 5.

Chạy:  E:\\Hermes\\hermes-agent\\venv\\Scripts\\python.exe E:\\Hermes\\lay-token-facebook.py

Script hỏi ba thứ, rồi tự làm phần còn lại:

  1. Đổi token ngắn hạn (sống 1 giờ) sang token dài hạn (60 ngày)
  2. Hỏi Facebook xem tài khoản quản trị những Page nào, lấy token của từng Page
  3. Kiểm chứng token đó có thật sự vĩnh viễn và đủ quyền không

Vì sao phải qua token dài hạn ở giữa: Page token chỉ vĩnh viễn khi được sinh ra
từ một token người dùng dài hạn. Lấy thẳng từ token ngắn hạn thì Page token cũng
chỉ sống một giờ, và ba tuần sau bot lăn ra hỏng mà không ai hiểu vì sao.

Cuối cùng script ghi các Page bạn chọn vào <hermes>/zalo/fb_pages.json.
Nó KHÔNG in token hay App Secret ra màn hình — bạn hay chụp màn hình gửi
người khác, mà token thì tương đương chìa khoá Page.
"""

import json
import sys
import urllib.parse
import urllib.request

API = "https://graph.facebook.com/v23.0"


def get(path: str, **params) -> dict:
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"error": {"message": f"HTTP {e.code}"}}
    except Exception as e:
        return {"error": {"message": str(e)}}


def die(msg: str, detail: str = "") -> None:
    print(f"\n❌ {msg}")
    if detail:
        print(f"   {detail}")
    sys.exit(1)


def ask(label: str) -> str:
    val = input(f"{label}: ").strip()
    if not val:
        die(f"Chưa nhập {label}")
    return val


print(__doc__.split("Chạy:")[0].strip())
print("=" * 68)
app_id = ask("App ID          ")
app_secret = ask("App Secret      ")
short = ask("Token ngắn hạn  ")

# --- Bước 3: đổi sang token dài hạn --------------------------------------
print("\n[1/3] Đổi sang token dài hạn (60 ngày)…")
r = get("oauth/access_token", grant_type="fb_exchange_token",
        client_id=app_id, client_secret=app_secret, fb_exchange_token=short)
if "error" in r:
    die("Không đổi được token.", r["error"].get("message", ""))
long_token = r.get("access_token")
if not long_token:
    die("Facebook không trả về token.", json.dumps(r)[:200])
print("      ✅ xong")

# --- Bước 4: lấy Page token ----------------------------------------------
print("[2/3] Hỏi danh sách Page bạn quản trị…")
r = get("me/accounts", access_token=long_token, fields="id,name,access_token")
if "error" in r:
    die("Không lấy được danh sách Page.", r["error"].get("message", ""))
pages = r.get("data") or []
if not pages:
    die("Không thấy Page nào.",
        "Tài khoản Facebook bạn dùng ở bước 2 chưa phải quản trị viên Page, "
        "hoặc lúc đăng nhập chưa tick chọn Page. Làm lại bước 2 và nhớ tick.")
print(f"      ✅ thấy {len(pages)} Page")

# --- Bước 5: kiểm chứng ---------------------------------------------------
print("[3/3] Kiểm chứng từng token…\n")
print("=" * 68)
for p in pages:
    tok = p.get("access_token", "")
    d = get("debug_token", input_token=tok,
            access_token=f"{app_id}|{app_secret}").get("data", {})
    forever = d.get("expires_at") == 0
    scopes = d.get("scopes") or []
    need = {"pages_show_list", "pages_read_engagement", "pages_read_user_content"}
    missing = sorted(need - set(scopes))

    print(f"\n📄 {p.get('name')}")
    print(f"   FB_PAGE_ID={p.get('id')}")
    print(f"   FB_PAGE_TOKEN={tok}")
    print(f"   {'✅' if forever else '❌'} vĩnh viễn: "
          f"{'có' if forever else 'KHÔNG — bạn đã bỏ qua bước đổi token dài hạn'}")
    if missing:
        print(f"   ⚠️  thiếu quyền: {', '.join(missing)}")
        print("      → làm lại bước 2, tick đủ ba quyền")
    else:
        print("   ✅ đủ quyền đọc bài và bình luận")

# --- Ghi ra tệp cấu hình ---------------------------------------------------
#
# Vì sao ghi ra tệp riêng chứ không nhét vào .env: mỗi token dài vài trăm ký tự
# và tên Page có dấu tiếng Việt lẫn khoảng trắng. Nhiều Page mà xếp hết vào
# .env thì thành một mớ không đọc nổi và rất dễ sửa nhầm dòng. Một tệp JSON thì
# nhìn ra ngay Page nào là Page nào.
import os

print("\n" + "=" * 68)
usable = [x for x in pages if x.get("access_token")]
if not usable:
    die("Không Page nào có token.")

print("\nChọn Page muốn bot điều khiển — gõ số thứ tự, cách nhau bởi dấu phẩy.")
print("Bỏ trống = lấy tất cả.\n")
for i, x in enumerate(usable, 1):
    print(f"   {i}. {x.get('name')}  (id {x.get('id')})")

raw = input("\nChọn: ").strip()
if raw:
    try:
        picked = [usable[int(v.strip()) - 1] for v in raw.split(",") if v.strip()]
    except (ValueError, IndexError):
        die("Số thứ tự không hợp lệ.")
else:
    picked = usable

default_idx = 0
if len(picked) > 1:
    print("\nPage nào là mặc định (khi bạn không nói rõ đăng lên Page nào)?")
    for i, x in enumerate(picked, 1):
        print(f"   {i}. {x.get('name')}")
    d = input("Chọn (bỏ trống = số 1): ").strip()
    try:
        default_idx = int(d) - 1 if d else 0
        picked[default_idx]
    except (ValueError, IndexError):
        die("Số thứ tự không hợp lệ.")

home = os.getenv("HERMES_HOME") or os.path.dirname(os.path.abspath(__file__))
out_dir = os.path.join(home, "zalo")
os.makedirs(out_dir, exist_ok=True)
out = os.path.join(out_dir, "fb_pages.json")

data = {"pages": [
    {"id": x.get("id"), "name": x.get("name"), "token": x.get("access_token"),
     "default": i == default_idx}
    for i, x in enumerate(picked)
]}
with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
try:
    os.chmod(out, 0o600)
except OSError:
    pass

print(f"\n✅ Đã ghi {len(picked)} Page vào:\n   {out}")
print("\nThêm MỘT dòng này vào cuối .env của Hermes:")
print(f"\n   FB_PAGES_FILE={out}\n")
print("Sau này thêm hoặc bớt Page thì chạy lại script, không phải sửa .env.")
print("\n⚠️  Tệp vừa ghi chứa token, tương đương chìa khoá Page —")
print("    đừng gửi cho ai, đừng dán vào Zalo hay ảnh chụp màn hình.")
