import { expect, test } from "@playwright/test";

test.describe("HA Hub", () => {
  test("renders configured HA and Zigbee2MQTT entry points", async ({ page }) => {
    await page.goto("/ha-hub");

    await expect(page.getByTestId("ha-hub-page")).toBeVisible();
    await expect(page.getByTestId("ha-root-link")).toHaveAttribute("href", "http://ha.local");
    await expect(page.getByTestId("z2m-root-link")).toHaveAttribute("href", "http://z2m.local");
    await expect(page.getByTestId("ha-hub-link-scenes")).toHaveAttribute("href", "http://ha.local/config/scene/dashboard");
    await expect(page.getByTestId("ha-hub-link-automations")).toHaveAttribute("href", "http://ha.local/config/automation/dashboard");
  });
});
