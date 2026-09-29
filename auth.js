const $ = id => document.getElementById(id);

function setError(id, message) {
  const el = $(id);
  if (el) el.textContent = message || "";
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function strongPassword(password) {
  return password.length >= 8 && /\d/.test(password) && /[^A-Za-z0-9]/.test(password);
}

async function readResponse(response) {
  try {
    return await response.json();
  } catch {
    return { message: "The server returned an invalid response." };
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const data = await readResponse(response);
  if (!response.ok) throw new Error(data.message || "Request failed.");
  return data;
}

async function signup(event) {
  event.preventDefault();

  const fullName = $("fullName").value.trim();
  const email = $("email").value.trim();
  const password = $("password").value;
  const confirmPassword = $("confirmPassword").value;
  const terms = $("terms").checked;
  let valid = true;

  ["nameError", "emailError", "passwordError", "confirmError", "termsError", "formError"].forEach(id => setError(id, ""));

  if (fullName.length < 2) { setError("nameError", "Please enter your full name."); valid = false; }
  if (!validEmail(email)) { setError("emailError", "Please enter a valid email address."); valid = false; }
  if (!strongPassword(password)) { setError("passwordError", "Use at least 8 characters with a number and special character."); valid = false; }
  if (password !== confirmPassword) { setError("confirmError", "Passwords do not match."); valid = false; }
  if (!terms) { setError("termsError", "You must agree before creating an account."); valid = false; }
  if (!valid) return;

  const button = $("submitBtn");
  button.disabled = true;
  button.textContent = "Creating account...";

  try {
    await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ fullName, email, password })
    });

    $("success").style.display = "block";
    $("success").textContent = "Account created successfully. Opening FloodGuard...";
    setTimeout(() => window.location.href = "/overview", 700);
  } catch (error) {
    setError("formError", error.message || "Unable to connect to the server.");
  } finally {
    button.disabled = false;
    button.textContent = "Create Account";
  }
}

async function login(event) {
  event.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  setError("formError", "");

  if (!validEmail(email)) return setError("formError", "Please enter a valid email address.");
  if (!password) return setError("formError", "Please enter your password.");

  const button = $("loginBtn");
  button.disabled = true;
  button.textContent = "Signing in...";

  try {
    await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });
    window.location.href = "/overview";
  } catch (error) {
    setError("formError", error.message || "Unable to connect to the server.");
  } finally {
    button.disabled = false;
    button.textContent = "Sign In";
  }
}

async function protectDashboard() {
  try {
    const data = await api("/api/auth/me");
    const name = $("userName");
    if (name) name.textContent = data.user.fullName;
  } catch {
    window.location.href = "/login";
  }
}

async function redirectIfAuthenticated() {
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (response.ok) window.location.href = "/overview";
  } catch {
    // No active session; remain on the authentication page.
  }
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/login";
  }
}
