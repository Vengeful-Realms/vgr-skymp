
const vgr_death_root = document.getElementById("vgr-death-screen");
const vgr_death_countdownEl = document.getElementById("vgrDeathCountdown");
const vgr_death_hintEl = document.getElementById("vgrDeathHint");
const vgrDeathState = { seconds: 0, timer: null };

function vgrDeathStopTimer() {
	if (vgrDeathState.timer) { clearInterval(vgrDeathState.timer); vgrDeathState.timer = null; }
}

function vgrDeathPaint() {
	if (vgrDeathState.seconds > 0) {
		vgr_death_countdownEl.textContent = String(vgrDeathState.seconds);
		vgr_death_hintEl.textContent = "You are bleeding out. You will wake at the nearest temple.";
	} else {
		vgr_death_countdownEl.textContent = "";
		vgr_death_hintEl.textContent = "You feel yourself being carried to safety...";
	}
}

window.vgrDeathScreenUpdate = (data) => {
	if (!data) return;
	vgrDeathStopTimer();
	if (data.show === true) {
		vgrDeathState.seconds = Math.max(0, Number(data.seconds) || 0);
		vgrDeathPaint();
		vgrDeathState.timer = setInterval(() => {
			vgrDeathState.seconds = Math.max(0, vgrDeathState.seconds - 1);
			vgrDeathPaint();
			if (vgrDeathState.seconds <= 0) vgrDeathStopTimer();
		}, 1000);
	} else {
		vgrDeathState.seconds = 0;
		vgrDeathPaint();
	}
};

window.addEventListener("vgr:ui_manager:open:death_screen", () => {
	vgr_death_root.style.display = "flex";
});

window.addEventListener("vgr:ui_manager:close:death_screen", () => {
	vgr_death_root.style.display = "none";
	vgrDeathStopTimer();
});
