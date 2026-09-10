"""Lấy Page Access Token vĩnh viễn của Facebook — làm thay bước 3, 4, 5.

Chạy từ thư mục repo:
    <hermes-python> scripts/lay-token-facebook.py

Script hỏi ba thứ, rồi tự làm phần còn lại:

  1. Đổi token ngắn hạn (sống 1 giờ) sang token dài hạn (60 ngày)
  2. Hỏi Facebook xem tài khoản quản trị những Page nào, lấy token của từng Page
  3. Kiểm chứng token đó có thật sự vĩnh viễn và đủ quyền không

Vì sao phải qua token dài hạn ở giữa: Page token chỉ vĩnh viễn khi được sinh ra
từ một token người dùng dài hạn. Lấy thẳng từ token ngắn hạn thì Page token cũng
chỉ sống một giờ, và ba tuần sau bot lăn ra hỏng mà không ai hiểu vì sao.

Cuối cùng script ghi các Page bạn chọn vào <hermes-home>/zalo/fb_pages.json.
Nó KHÔNG in token hay App Secret ra màn hình — bạn hay chụp màn hình gửi
người khác, mà token thì tương đương chìa khoá Page.
"""

import getpass
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://graph.facebook.com/v23.0"
NEEDED_SCOPES = {"pages_show_list", "pages_read_engagement", "pages_read_user_content"}


def get(path: str, **params) -> dict:
    url = f"{API}/{path}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        try:
            return json.loads(error.read().decode())
        except Exception:
            return {"error": {"message": f"HTTP {error.code}"}}
    except Exception as error:
        return {"error": {"message": str(error)}}


def die(message: str, detail: str = "") -> None:
    print(f"\n❌ {message}")
    if detail:
        print(f"   {detail}")
    raise SystemExit(1)


def ask(label: str, *, secret: bool = False) -> str:
    value = (getpass.getpass(f"{label}: ") if secret else input(f"{label}: ")).strip()
    if not value:
        die(f"Chưa nhập {label}")
    return value


def _looks_like_hermes(path: Path) -> bool:
    return (path / "config.yaml").is_file() or (path / ".env").is_file()


def resolve_hermes_home(*, env=None, os_name=None, user_home=None) -> Path:
    env = os.environ if env is None else env
    os_name = os.name if os_name is None else os_name
    user_home = str(Path.home()) if user_home is None else user_home

    explicit = str(env.get("HERMES_HOME") or "").strip()
    if explicit:
        return Path(explicit)

    candidates = []
    if os_name == "nt" and env.get("LOCALAPPDATA"):
        candidates.append(Path(env["LOCALAPPDATA"]) / "hermes")
    candidates.append(Path(user_home) / ".hermes")

    for candidate in candidates:
        if _looks_like_hermes(candidate):
            return candidate
    raise RuntimeError("Không tìm thấy Hermes; hãy đặt HERMES_HOME tới thư mục cài Hermes")


def print_page_status(page: dict, *, forever: bool, missing: list[str]) -> None:
    print(f"\n📄 {page.get('name')}")
    print(f"   FB_PAGE_ID={page.get('id')}")
    print(f"   {'✅' if forever else '❌'} vĩnh viễn: "
          f"{'có' if forever else 'KHÔNG — bạn đã bỏ qua bước đổi token dài hạn'}")
    if missing:
        print(f"   ⚠️  thiếu quyền: {', '.join(missing)}")
        print("      → làm lại bước 2, tick đủ ba quyền")
    else:
        print("   ✅ đủ quyền đọc bài và bình luận")


def _safe_detail(value, secrets) -> str:
    detail = str(value or "")
    for secret in secrets:
        if secret:
            detail = detail.replace(str(secret), "[đã ẩn]")
    return detail


def main() -> None:
    print(__doc__.split("Chạy từ")[0].strip())
    print("=" * 68)
    app_id = ask("App ID          ")
    app_secret = ask("App Secret      ", secret=True)
    short_token = ask("Token ngắn hạn  ", secret=True)

    print("\n[1/3] Đổi sang token dài hạn (60 ngày)…")
    result = get(
        "oauth/access_token",
        grant_type="fb_exchange_token",
        client_id=app_id,
        client_secret=app_secret,
        fb_exchange_token=short_token,
    )
    if "error" in result:
        die("Không đổi được token.", _safe_detail(result["error"].get("message", ""), [app_secret, short_token]))
    long_token = result.get("access_token")
    if not long_token:
        die("Facebook không trả về token.")
    print("      ✅ xong")

    print("[2/3] Hỏi danh sách Page bạn quản trị…")
    result = get("me/accounts", access_token=long_token, fields="id,name,access_token")
    if "error" in result:
        die(
            "Không lấy được danh sách Page.",
            _safe_detail(result["error"].get("message", ""), [app_secret, short_token, long_token]),
        )
    pages = result.get("data") or []
    if not pages:
        die(
            "Không thấy Page nào.",
            "Tài khoản Facebook bạn dùng ở bước 2 chưa phải quản trị viên Page, "
            "hoặc lúc đăng nhập chưa tick chọn Page. Làm lại bước 2 và nhớ tick.",
        )
    print(f"      ✅ thấy {len(pages)} Page")

    print("[3/3] Kiểm chứng từng token…\n")
    print("=" * 68)
    for page in pages:
        page_token = page.get("access_token", "")
        debug = get(
            "debug_token",
            input_token=page_token,
            access_token=f"{app_id}|{app_secret}",
        ).get("data", {})
        forever = debug.get("expires_at") == 0
        missing = sorted(NEEDED_SCOPES - set(debug.get("scopes") or []))
        print_page_status(page, forever=forever, missing=missing)

    print("\n" + "=" * 68)
    usable = [page for page in pages if page.get("access_token")]
    if not usable:
        die("Không Page nào có token.")

    print("\nChọn Page muốn bot điều khiển — gõ số thứ tự, cách nhau bởi dấu phẩy.")
    print("Bỏ trống = lấy tất cả.\n")
    for index, page in enumerate(usable, 1):
        print(f"   {index}. {page.get('name')}  (id {page.get('id')})")

    raw = input("\nChọn: ").strip()
    if raw:
        try:
            picked = [usable[int(value.strip()) - 1] for value in raw.split(",") if value.strip()]
        except (ValueError, IndexError):
            die("Số thứ tự không hợp lệ.")
    else:
        picked = usable

    default_index = 0
    if len(picked) > 1:
        print("\nPage nào là mặc định (khi bạn không nói rõ đăng lên Page nào)?")
        for index, page in enumerate(picked, 1):
            print(f"   {index}. {page.get('name')}")
        choice = input("Chọn (bỏ trống = số 1): ").strip()
        try:
            default_index = int(choice) - 1 if choice else 0
            picked[default_index]
        except (ValueError, IndexError):
            die("Số thứ tự không hợp lệ.")

    try:
        home = resolve_hermes_home()
    except RuntimeError as error:
        die(str(error))
    out_dir = home / "zalo"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "fb_pages.json"

    data = {
        "pages": [
            {
                "id": page.get("id"),
                "name": page.get("name"),
                "token": page.get("access_token"),
                "default": index == default_index,
            }
            for index, page in enumerate(picked)
        ]
    }
    with out.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)
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


if __name__ == "__main__":
    main()
