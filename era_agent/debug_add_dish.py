import asyncio, os
from playwright.async_api import async_playwright

async def test():
    p = await async_playwright().start()
    app_data = os.environ.get("LOCALAPPDATA", "C:\\Users\\MSI\\AppData\\Local")
    edge_profile = os.path.join(app_data, "ERA", "edge_food_profile")
    geo = {"lat": 27.1767, "lon": 78.0081}
    edge_user_agent = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
    )
    browser_args = [
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
        "--disable-infobars",
        "--no-default-browser-check",
        "--no-first-run",
    ]
    ctx = await p.chromium.launch_persistent_context(
        user_data_dir=edge_profile,
        channel="msedge",
        headless=False,
        user_agent=edge_user_agent,
        permissions=["geolocation"],
        geolocation={"latitude": geo["lat"], "longitude": geo["lon"]},
        no_viewport=True,
        args=browser_args,
    )
    page = ctx.pages[0] if ctx.pages else await ctx.new_page()

    # 1. Direct search URL
    search_url = "https://www.swiggy.com/search?query=burger"
    print("Navigating to search URL:", search_url)
    await page.goto(search_url, timeout=30000, wait_until="domcontentloaded")
    await asyncio.sleep(4)

    # 2. Click Dishes tab
    dishes_tab = page.locator("button:has-text('Dishes'), span:text-is('Dishes'), div:text-is('Dishes')").first
    if await dishes_tab.count() > 0:
        print("Clicking Dishes tab...")
        await dishes_tab.click()
        await asyncio.sleep(3)

    # 3. Check for ADD buttons
    btns = await page.locator(".add-button-center-container, button.add-button-center-container, div.add-button-center-container").all()
    print(f"Found {len(btns)} ADD button containers on Dishes tab.")

    if btns:
        # Click first button
        print("Clicking first ADD button...")
        await btns[0].scroll_into_view_if_needed()
        await btns[0].click()
        await asyncio.sleep(2)

        # Check for Reset Cart / Start Afresh popup
        reset_btns = await page.locator("button:has-text('Start Afresh'), button:has-text('Reset cart'), div:has-text('Start Afresh'), button:has-text('YES, START AFRESH')").all()
        print(f"Reset / Start afresh buttons visible: {len(reset_btns)}")
        if reset_btns:
            await reset_btns[-1].click()
            print("Clicked Start Afresh!")
            await asyncio.sleep(2)

        # Check for Customization modal (e.g. Choose Crust, Size, Add-ons)
        for step in range(3):
            # Check radio buttons or continue button
            cust_btn = page.locator("button:has-text('Continue'), button:has-text('Add Item'), button:has-text('ADD ITEM TO CART'), div:has-text('Continue')").first
            if await cust_btn.count() > 0:
                print(f"Customization step {step + 1} button found: {await cust_btn.inner_text()}")
                await cust_btn.click()
                await asyncio.sleep(1.5)
            else:
                break

        # Check if bottom cart floating bar appeared!
        await asyncio.sleep(2)
        cart_bar = await page.evaluate("""() => {
            const bar = document.querySelector('div[class*="cart"], div[class*="Cart"], a[href*="checkout"]');
            const txt = document.body.innerText;
            return {
                hasCheckoutLink: !!document.querySelector('a[href*="checkout"]'),
                checkoutLinkText: document.querySelector('a[href*="checkout"]') ? document.querySelector('a[href*="checkout"]').innerText : null,
                bodySnippet: txt.substring(0, 300)
            };
        }""")
        print("Cart bar status:", cart_bar)

        # Now go to checkout
        print("Navigating to https://www.swiggy.com/checkout...")
        await page.goto("https://www.swiggy.com/checkout", timeout=30000, wait_until="domcontentloaded")
        await asyncio.sleep(4)

        co_status = await page.evaluate("""() => {
            const text = document.body.innerText;
            const isEmpty = text.includes('Your cart is empty') || text.includes('Oops, something went wrong') || text.includes('Cart Empty');
            let toPay = null;
            const lines = text.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
            for (let i = 0; i < lines.length; i++) {
                if (lines[i] === 'TO PAY' && i + 1 < lines.length) toPay = lines[i + 1];
            }
            return { isEmpty, toPay, preview: text.substring(0, 400) };
        }""")
        print("Checkout status:", co_status)

    await ctx.close()
    await p.stop()

if __name__ == "__main__":
    asyncio.run(test())
