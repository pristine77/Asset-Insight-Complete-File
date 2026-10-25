import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
  Image,
  ImageBackground,
  Animated,
  useWindowDimensions,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import authService, { SignupPayload, type AuthResponse } from '../services/authService';
import { Feather } from '@expo/vector-icons';
import { useAppTheme, type AppThemeColors } from '../context/ThemeContext';
import AccountPrivacyLinks from '../components/AccountPrivacyLinks';

// The app icon's wordmark cropped tight (862 x 294, transparent): the square
// icon squeezed into this frame showed the words about 10 points tall.
const BrandWordmark = require('../../assets/asset-insight-wordmark.png');
const EquipmentArtwork = require('../../assets/auth-equipment-yard.png');

type AuthView =
  | 'signIn'
  | 'signUpStep1'
  | 'signUpStep2'
  | 'verify'
  | 'forgotPassword'
  | 'resetPassword';

const AuthScreen: React.FC = () => {
  const { login, refreshUser, loading: authLoading, error: authError, clearError } = useAuth();
  const { width } = useWindowDimensions();
  const isCompact = width < 380;
  const { isDark, colors, toggleTheme } = useAppTheme();
  const st = useMemo(() => createStyles(colors, isCompact), [colors, isCompact]);

  // Navigation
  const [view, setView] = useState<AuthView>('signIn');

  // Sign-in
  const [signInEmail, setSignInEmail] = useState('');
  const [signInPassword, setSignInPassword] = useState('');
  const [showSignInPw, setShowSignInPw] = useState(false);

  // Sign-up credentials
  const [username, setUsername] = useState('');
  const [signUpEmail, setSignUpEmail] = useState('');
  const [signUpPassword, setSignUpPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showSignUpPw, setShowSignUpPw] = useState(false);

  // Sign-up details
  const [companyName, setCompanyName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [companyAddress, setCompanyAddress] = useState('');

  // Verification
  const [verifyEmailAddr, setVerifyEmailAddr] = useState('');
  const [verifyCode, setVerifyCode] = useState('');

  // Forgot / Reset
  const [forgotEmail, setForgotEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPw, setConfirmNewPw] = useState('');
  const [showNewPw, setShowNewPw] = useState(false);

  // UI
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const actionPending = useRef(false);

  // Animations
  const heroAnim = useRef(new Animated.Value(0)).current;
  const formAnim = useRef(new Animated.Value(0)).current;

  const loading = localLoading || authLoading;

  /* ---------- Animations ---------- */

  useEffect(() => {
    Animated.parallel([
      Animated.timing(heroAnim, { toValue: 1, duration: 520, useNativeDriver: true }),
      Animated.timing(formAnim, { toValue: 1, duration: 620, useNativeDriver: true }),
    ]).start();
  }, [formAnim, heroAnim]);

  /* ---------- Deep link (reset-password) ---------- */

  useEffect(() => {
    const handleUrl = (event: { url: string }) => {
      if (event.url?.includes('reset-password')) {
        const match = event.url.match(/[?&]token=([^&]+)/);
        if (match && !actionPending.current) {
          let token: string;
          try { token = decodeURIComponent(match[1]); } catch { return; }
          if (!token.trim()) return;
          setLocalError(null);
          setSuccessMsg(null);
          clearError();
          setResetCode('');
          setResetToken(token);
          setSuccessMsg('Secure reset link opened. Choose a new password below.');
          setView('resetPassword');
        }
      }
    };
    const sub = Linking.addEventListener('url', handleUrl);
    Linking.getInitialURL().then((url) => { if (url) handleUrl({ url }); });
    return () => sub.remove();
  }, [clearError]);

  /* ---------- Helpers ---------- */

  const clearLocal = useCallback(() => {
    setLocalError(null);
    setSuccessMsg(null);
    clearError();
  }, [clearError]);

  const transitionToView = useCallback(
    (target: AuthView) => {
      setView(target);
      formAnim.setValue(0);
      Animated.timing(formAnim, { toValue: 1, duration: 380, useNativeDriver: true }).start();
    },
    [formAnim],
  );

  const navigateTo = useCallback(
    (target: AuthView) => {
      if (actionPending.current) return;
      clearLocal();
      transitionToView(target);
    },
    [clearLocal, transitionToView],
  );

  /* ---------- Handlers ---------- */

  const handleSignIn = async () => {
    if (actionPending.current) return;
    clearLocal();
    if (!signInEmail.trim()) { setLocalError('Please enter your email.'); return; }
    if (!signInPassword) { setLocalError('Please enter your password.'); return; }
    actionPending.current = true;
    setLocalLoading(true);
    try {
      await login({ email: signInEmail.trim().toLowerCase(), password: signInPassword });
    } catch (err: any) {
      if (err.code === 'EMAIL_NOT_VERIFIED' || err.message === 'Please verify your email before logging in.') {
        setVerifyEmailAddr(signInEmail.trim().toLowerCase());
        setVerifyCode('');
        clearError();
        setLocalError(null);
        transitionToView('verify');
        return;
      }
      setLocalError(err.message || 'Login failed. Please try again.');
    } finally {
      actionPending.current = false;
      setLocalLoading(false);
    }
  };

  const handleSignUpNext = () => {
    clearLocal();
    if (!username.trim()) { setLocalError('Username is required.'); return; }
    if (!signUpEmail.trim()) { setLocalError('Email is required.'); return; }
    if (!signUpPassword) { setLocalError('Password is required.'); return; }
    if (signUpPassword.length < 6) { setLocalError('Password must be at least 6 characters.'); return; }
    if (signUpPassword !== confirmPassword) { setLocalError('Passwords do not match.'); return; }
    navigateTo('signUpStep2');
  };

  const handleSignUpSubmit = async () => {
    if (actionPending.current) return;
    clearLocal();
    actionPending.current = true;
    setLocalLoading(true);
    try {
      const payload: SignupPayload = {
        username: username.trim(),
        email: signUpEmail.trim().toLowerCase(),
        password: signUpPassword,
      };
      if (companyName.trim()) payload.companyName = companyName.trim();
      if (contactEmail.trim()) payload.contactEmail = contactEmail.trim().toLowerCase();
      if (contactPhone.trim()) payload.contactPhone = contactPhone.trim();
      if (companyAddress.trim()) payload.companyAddress = companyAddress.trim();

      const res = await authService.signup(payload);
      setVerifyEmailAddr(signUpEmail.trim().toLowerCase());
      setSuccessMsg(res.message || 'Account created! Check your email for a verification code.');
      transitionToView('verify');
    } catch (err: any) {
      setLocalError(err.response?.data?.message || err.message || 'Sign up failed.');
    } finally {
      actionPending.current = false;
      setLocalLoading(false);
    }
  };

  const handleVerify = async () => {
    if (actionPending.current) return;
    clearLocal();
    if (!/^\d{6}$/.test(verifyCode.trim())) { setLocalError('Please enter the 6-digit verification code.'); return; }
    actionPending.current = true;
    setLocalLoading(true);
    try {
      const response = await authService.verifyEmail({ email: verifyEmailAddr, verificationCode: verifyCode.trim() });
      if (response.authState === 'authenticated') await refreshUser();
    } catch (err: any) {
      setLocalError(err.response?.data?.message || err.message || 'Verification failed.');
    } finally {
      actionPending.current = false;
      setLocalLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (actionPending.current) return;
    clearLocal();
    actionPending.current = true;
    setLocalLoading(true);
    try {
      const res = await authService.resendVerificationCode(verifyEmailAddr);
      setSuccessMsg(res.message || 'Verification code resent!');
    } catch (err: any) {
      setLocalError(err.response?.data?.message || err.message || 'Failed to resend code.');
    } finally {
      actionPending.current = false;
      setLocalLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (actionPending.current) return;
    clearLocal();
    if (!forgotEmail.trim()) { setLocalError('Please enter your email.'); return; }
    actionPending.current = true;
    setLocalLoading(true);
    try {
      const normalizedEmail = forgotEmail.trim().toLowerCase();
      const res = await authService.forgotPassword(normalizedEmail);
      setForgotEmail(normalizedEmail);
      setResetCode('');
      setResetToken('');
      setSuccessMsg(res.message || 'If an account with that email exists, a password reset code has been sent.');
      transitionToView('resetPassword');
    } catch (err: any) {
      setLocalError(err.response?.data?.message || err.message || 'Failed to send reset code.');
    } finally {
      actionPending.current = false;
      setLocalLoading(false);
    }
  };

  const handleResendResetCode = async () => {
    if (actionPending.current) return;
    clearLocal();
    if (!forgotEmail.trim()) { setLocalError('Please enter your email first.'); return; }
    actionPending.current = true;
    setLocalLoading(true);
    try {
      const normalizedEmail = forgotEmail.trim().toLowerCase();
      const res = await authService.forgotPassword(normalizedEmail);
      setForgotEmail(normalizedEmail);
      setSuccessMsg(res.message || 'A new password reset code has been sent.');
    } catch (err: any) {
      setLocalError(err.response?.data?.message || err.message || 'Failed to resend reset code.');
    } finally {
      actionPending.current = false;
      setLocalLoading(false);
    }
  };

  const handleResetPassword = async () => {
    if (actionPending.current) return;
    clearLocal();
    if (!newPassword) { setLocalError('Please enter a new password.'); return; }
    if (newPassword.length < 6) { setLocalError('Password must be at least 6 characters.'); return; }
    if (newPassword !== confirmNewPw) { setLocalError('Passwords do not match.'); return; }
    actionPending.current = true;
    setLocalLoading(true);
    try {
      let response: AuthResponse;
      if (resetToken) {
        response = await authService.resetPassword({ token: resetToken, password: newPassword });
      } else {
        const normalizedEmail = forgotEmail.trim().toLowerCase();
        if (!normalizedEmail) { setLocalError('Please enter the email used for the reset request.'); return; }
        if (!/^\d{6}$/.test(resetCode.trim())) { setLocalError('Please enter the 6-digit reset code.'); return; }
        response = await authService.resetPasswordByCode({
          email: normalizedEmail,
          code: resetCode.trim(),
          password: newPassword,
        });
      }
      if (response.authState === 'authenticated') await refreshUser();
    } catch (err: any) {
      setLocalError(err.response?.data?.message || err.message || 'Password reset failed.');
    } finally {
      actionPending.current = false;
      setLocalLoading(false);
    }
  };

  /* ---------- Shared Renderers ---------- */

  const errorText = localError || authError;
  const isTokenResetFlow = !!resetToken;

  const renderError = () =>
    errorText ? (
      <View style={st.errorBox}>
        <Text style={st.errorText}>{errorText}</Text>
      </View>
    ) : null;

  const renderSuccess = () =>
    successMsg ? (
      <View style={st.successBox}>
        <Text style={st.successText}>{successMsg}</Text>
      </View>
    ) : null;

  const renderInput = (
    label: string,
    value: string,
    onChangeText: (t: string) => void,
    opts?: {
      placeholder?: string;
      secure?: boolean;
      showToggle?: boolean;
      shown?: boolean;
      onToggle?: () => void;
      keyboard?: 'default' | 'email-address' | 'phone-pad' | 'number-pad';
      autoCap?: 'none' | 'sentences' | 'words';
      maxLength?: number;
    },
  ) => (
    <View style={st.fieldWrap}>
      <Text style={st.fieldLabel}>{label}</Text>
      {opts?.showToggle ? (
        <View style={st.pwRow}>
          <TextInput
            accessibilityLabel={label}
            style={st.pwInput}
            value={value}
            onChangeText={onChangeText}
            placeholder={opts.placeholder || label}
            placeholderTextColor={colors.textMuted}
            secureTextEntry={!opts.shown}
            autoCapitalize="none"
            maxLength={opts.maxLength}
            editable={!loading}
          />
          <TouchableOpacity onPress={opts.onToggle} style={st.eyeBtn}>
            <Text style={st.eyeText}>{opts.shown ? 'Hide' : 'Show'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <TextInput
          accessibilityLabel={label}
          style={st.textInput}
          value={value}
          onChangeText={onChangeText}
          placeholder={opts?.placeholder || label}
          placeholderTextColor={colors.textMuted}
          secureTextEntry={opts?.secure}
          keyboardType={opts?.keyboard || 'default'}
          autoCapitalize={opts?.autoCap ?? 'none'}
          autoCorrect={false}
          maxLength={opts?.maxLength}
          editable={!loading}
        />
      )}
    </View>
  );

  const renderStepBar = (current: number, total: number) => (
    <View style={st.stepRow}>
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          style={[st.stepDot, i < current && st.stepDone, i === current && st.stepActive]}
        />
      ))}
      <Text style={st.stepLabel}>
        Step {current + 1} of {total}
      </Text>
    </View>
  );

  const renderInfoPanel = (badge: string, title: string, description: string, email?: string) => (
    <View style={st.infoPanel}>
      <View style={st.infoBadge}>
        <Text style={st.infoBadgeText}>{badge}</Text>
      </View>
      <Text style={st.infoTitle}>{title}</Text>
      <Text style={st.infoBody}>{description}</Text>
      {email ? (
        <View style={st.emailChip}>
          <Text style={st.emailChipText}>{email}</Text>
        </View>
      ) : null}
    </View>
  );

  /* ---------- View Renderers ---------- */

  const cardAnim = {
    opacity: formAnim,
    transform: [
      { translateY: formAnim.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }) },
    ],
  };

  const renderSignIn = () => (
    <>
      <Animated.View style={[st.card, cardAnim]}>
        <Text style={st.cardTitle}>Welcome Back</Text>
        <Text style={st.cardSub}>Sign in to continue</Text>
        {renderError()}
        {renderInput('Email', signInEmail, setSignInEmail, {
          keyboard: 'email-address',
          placeholder: 'Enter your email',
        })}
        {renderInput('Password', signInPassword, setSignInPassword, {
          placeholder: 'Enter your password',
          showToggle: true,
          shown: showSignInPw,
          onToggle: () => setShowSignInPw((p) => !p),
        })}
        <TouchableOpacity onPress={() => navigateTo('forgotPassword')} style={st.forgotLink}>
          <Text style={st.forgotText}>Forgot password?</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[st.btnPrimary, loading && st.btnOff]}
          onPress={handleSignIn}
          disabled={loading}
          activeOpacity={0.85}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={st.btnPrimaryTxt}>Sign In</Text>
          )}
        </TouchableOpacity>
        <View style={st.switchRow}>
          <Text style={st.switchLabel}>Don&apos;t have an account?</Text>
          <TouchableOpacity onPress={() => navigateTo('signUpStep1')}>
            <Text style={st.switchLink}>Create Account</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </>
  );

  const renderSignUpStep1 = () => (
    <Animated.View style={[st.card, cardAnim]}>
      <Text style={st.cardTitle}>Create Account</Text>
      {renderStepBar(0, 2)}
      {renderError()}
      {renderInput('Username', username, setUsername, { placeholder: 'Choose a username' })}
      {renderInput('Email', signUpEmail, setSignUpEmail, {
        keyboard: 'email-address',
        placeholder: 'Your email address',
      })}
      {renderInput('Password', signUpPassword, setSignUpPassword, {
        placeholder: 'Create a password',
        showToggle: true,
        shown: showSignUpPw,
        onToggle: () => setShowSignUpPw((p) => !p),
      })}
      {renderInput('Confirm Password', confirmPassword, setConfirmPassword, {
        placeholder: 'Re-enter password',
        secure: true,
      })}
      <TouchableOpacity
        style={[st.btnPrimary, loading && st.btnOff]}
        onPress={handleSignUpNext}
        disabled={loading}
        activeOpacity={0.85}>
        <Text style={st.btnPrimaryTxt}>Continue</Text>
      </TouchableOpacity>
      <View style={st.switchRow}>
        <Text style={st.switchLabel}>Already have an account?</Text>
        <TouchableOpacity onPress={() => navigateTo('signIn')}>
          <Text style={st.switchLink}>Sign In</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );

  const renderSignUpStep2 = () => (
    <Animated.View style={[st.card, cardAnim]}>
      <Text style={st.cardTitle}>Company Details</Text>
      <Text style={st.cardSub}>Optional — you can add these later</Text>
      {renderStepBar(1, 2)}
      {renderError()}
      {renderInput('Company Name', companyName, setCompanyName, {
        placeholder: 'Your company name',
        autoCap: 'words',
      })}
      {renderInput('Contact Email', contactEmail, setContactEmail, {
        keyboard: 'email-address',
        placeholder: 'Business email',
      })}
      {renderInput('Contact Phone', contactPhone, setContactPhone, {
        keyboard: 'phone-pad',
        placeholder: 'Phone number',
      })}
      {renderInput('Company Address', companyAddress, setCompanyAddress, {
        placeholder: 'Street address',
        autoCap: 'words',
      })}
      <View style={st.btnRow}>
        <TouchableOpacity
          style={[st.btnOutline, { flex: 1 }, loading && st.btnOff]}
          onPress={() => navigateTo('signUpStep1')}
          disabled={loading}
          activeOpacity={0.85}>
          <Text style={st.btnOutlineTxt}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[st.btnPrimary, { flex: 1 }, loading && st.btnOff]}
          onPress={handleSignUpSubmit}
          disabled={loading}
          activeOpacity={0.85}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={st.btnPrimaryTxt}>Create Account</Text>
          )}
        </TouchableOpacity>
      </View>
    </Animated.View>
  );

  const renderVerifyView = () => (
    <Animated.View style={[st.card, cardAnim]}>
      <View style={st.iconCircle}>
        <Text style={st.iconEmoji}>✉️</Text>
      </View>
      <Text style={st.cardTitle}>Verify Your Email</Text>
      <Text style={st.cardSub}>Finish setting up your account with the code from your inbox.</Text>
      {renderInfoPanel(
        '6-digit verification',
        'Check your inbox',
        'Enter the verification code we sent. It expires in 10 minutes for your security.',
        verifyEmailAddr,
      )}
      {renderError()}
      {renderSuccess()}
      {renderInput('Verification Code', verifyCode, (text) => setVerifyCode(text.replace(/\D/g, '').slice(0, 6)), {
        placeholder: '000000',
        keyboard: 'number-pad',
        maxLength: 6,
      })}
      <TouchableOpacity
        style={[st.btnPrimary, loading && st.btnOff]}
        onPress={handleVerify}
        disabled={loading}
        activeOpacity={0.85}>
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={st.btnPrimaryTxt}>Verify</Text>
        )}
      </TouchableOpacity>
      <TouchableOpacity onPress={handleResendCode} disabled={loading} style={st.resendBtn}>
        <Text style={st.resendText}>Didn&apos;t get a verification code? Resend verification code</Text>
      </TouchableOpacity>
      <View style={st.switchRow}>
        <TouchableOpacity onPress={() => navigateTo('signIn')}>
          <Text style={st.switchLink}>Back to Sign In</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );

  const renderForgotView = () => (
    <Animated.View style={[st.card, cardAnim]}>
      <View style={st.iconCircle}>
        <Text style={st.iconEmoji}>🔑</Text>
      </View>
      <Text style={st.cardTitle}>Reset Password</Text>
      <Text style={st.cardSub}>Recover access with a quick email code.</Text>
      {renderInfoPanel(
        'Password recovery',
        'Get a reset code',
        'Enter your account email and we’ll send a 6-digit code you can use right here in the app.',
      )}
      {renderError()}
      {renderSuccess()}
      {renderInput('Email', forgotEmail, setForgotEmail, {
        keyboard: 'email-address',
        placeholder: 'Your email address',
      })}
      <TouchableOpacity
        style={[st.btnPrimary, loading && st.btnOff]}
        onPress={handleForgotPassword}
        disabled={loading}
        activeOpacity={0.85}>
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={st.btnPrimaryTxt}>Send Reset Code</Text>
        )}
      </TouchableOpacity>
      <View style={st.switchRow}>
        <TouchableOpacity onPress={() => navigateTo('signIn')}>
          <Text style={st.switchLink}>Back to Sign In</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );

  const renderResetView = () => (
    <Animated.View style={[st.card, cardAnim]}>
      <View style={st.iconCircle}>
        <Text style={st.iconEmoji}>🔒</Text>
      </View>
      <Text style={st.cardTitle}>New Password</Text>
      <Text style={st.cardSub}>Complete the reset and get back into your workspace.</Text>
      {renderInfoPanel(
        isTokenResetFlow ? 'Secure reset link' : '6-digit reset code',
        isTokenResetFlow ? 'Reset link opened' : 'Enter your reset code',
        isTokenResetFlow
          ? 'Choose a new password. The link will be checked when you submit.'
          : 'Use the 6-digit code from your email, then choose a strong new password.',
        !isTokenResetFlow ? forgotEmail.trim().toLowerCase() : undefined,
      )}
      {renderError()}
      {renderSuccess()}
      {!isTokenResetFlow ? renderInput('Reset Code', resetCode, (text) => setResetCode(text.replace(/\D/g, '').slice(0, 6)), {
        placeholder: '000000',
        keyboard: 'number-pad',
        maxLength: 6,
      }) : null}
      {renderInput('New Password', newPassword, setNewPassword, {
        placeholder: 'Enter new password',
        showToggle: true,
        shown: showNewPw,
        onToggle: () => setShowNewPw((p) => !p),
      })}
      {renderInput('Confirm Password', confirmNewPw, setConfirmNewPw, {
        placeholder: 'Re-enter new password',
        secure: true,
      })}
      <TouchableOpacity
        style={[st.btnPrimary, loading && st.btnOff]}
        onPress={handleResetPassword}
        disabled={loading}
        activeOpacity={0.85}>
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={st.btnPrimaryTxt}>Reset Password</Text>
        )}
      </TouchableOpacity>
      {!isTokenResetFlow ? (
        <TouchableOpacity onPress={handleResendResetCode} disabled={loading} style={st.resendBtn}>
          <Text style={st.resendText}>Didn&apos;t get the reset code? Resend reset code</Text>
        </TouchableOpacity>
      ) : null}
      <View style={st.switchRow}>
        {!isTokenResetFlow ? (
          <TouchableOpacity onPress={() => navigateTo('forgotPassword')}>
            <Text style={st.switchLink}>Use Another Email</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity onPress={() => navigateTo('signIn')}>
          <Text style={st.switchLink}>Back to Sign In</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );

  /* ---------- Main Render ---------- */

  const headerTitle =
    view === 'signIn'
      ? 'Welcome to Asset Insight'
      : view.startsWith('signUp')
        ? 'Join Asset Insight'
        : 'Asset Insight';

  return (
    <SafeAreaView style={st.container}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={st.flex}>
        <ScrollView
          contentContainerStyle={[st.scroll, isCompact && st.scrollCompact]}
          keyboardShouldPersistTaps="handled">
          <Animated.View style={[st.header, { opacity: heroAnim }]}>
            <ImageBackground source={EquipmentArtwork} style={st.headerArtwork} imageStyle={st.headerArtworkImage}>
              <View style={st.headerTopRow}>
                <View style={st.logoFrame}>
                  <Image source={BrandWordmark} style={st.logoImg} resizeMode="contain" accessibilityLabel="Asset Insight" />
                </View>
                <TouchableOpacity onPress={toggleTheme} style={st.themeButton} activeOpacity={0.75}>
                  <Feather name={isDark ? 'sun' : 'moon'} size={18} color="#FFFFFF" />
                </TouchableOpacity>
              </View>
              <View style={st.headerCopy}>
                <Text style={[st.title, isCompact && st.titleSm]}>{headerTitle}</Text>
                <Text style={st.subtitle}>Appraisal, auction, and CRM work in one secure workspace.</Text>
              </View>
            </ImageBackground>
          </Animated.View>

          {/* Active View */}
          {view === 'signIn' && renderSignIn()}
          {view === 'signUpStep1' && renderSignUpStep1()}
          {view === 'signUpStep2' && renderSignUpStep2()}
          {view === 'verify' && renderVerifyView()}
          {view === 'forgotPassword' && renderForgotView()}
          {view === 'resetPassword' && renderResetView()}
          <AccountPrivacyLinks />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

/* ============================== STYLES ============================== */

const createStyles = (colors: AppThemeColors, isCompact: boolean) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  bgLayer: { ...StyleSheet.absoluteFillObject },
  blobOne: {
    position: 'absolute',
    width: 230,
    height: 230,
    borderRadius: 999,
    backgroundColor: '#93C5FD',
    top: -64,
    right: -40,
  },
  blobTwo: {
    position: 'absolute',
    width: 240,
    height: 240,
    borderRadius: 999,
    backgroundColor: '#BFDBFE',
    bottom: -88,
    left: -70,
  },
  scroll: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: isCompact ? 12 : 18, paddingVertical: 16, maxWidth: 560, width: '100%', alignSelf: 'center' },
  scrollCompact: { paddingVertical: 16 },

  /* Header */
  header: { marginBottom: 14, borderRadius: 12, overflow: 'hidden', shadowColor: colors.shadow, shadowOffset: { width: 0, height: 9 }, shadowOpacity: 0.2, shadowRadius: 16, elevation: 9, borderBottomWidth: 4, borderBottomColor: colors.accent },
  headerArtwork: { minHeight: isCompact ? 205 : 235, padding: 14, justifyContent: 'space-between', backgroundColor: colors.graphite },
  headerArtworkImage: { resizeMode: 'cover' },
  headerTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerCopy: { backgroundColor: 'rgba(9,12,18,0.84)', borderLeftWidth: 4, borderLeftColor: colors.accent, borderRadius: 8, padding: 12 },
  themeButton: { width: 40, height: 40, borderRadius: 9, backgroundColor: 'rgba(9,12,18,0.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.24)', alignItems: 'center', justifyContent: 'center' },
  brandPill: {
    borderRadius: 999,
    backgroundColor: '#DBEAFE',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginBottom: 12,
  },
  brandPillText: { color: '#1D4ED8', fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  logoFrame: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.82)',
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.22,
    shadowRadius: 14,
    elevation: 8,
  },
  // 862 x 294 wordmark: 120 wide is 41 tall.
  logoImg: { width: 120, height: 41 },
  title: {
    fontSize: 31,
    fontWeight: '800',
    color: '#FFFFFF',
    marginBottom: 4,
    letterSpacing: -0.6,
    textAlign: 'left',
  },
  titleSm: { fontSize: 27 },
  subtitle: { fontSize: 12, color: '#D5DAE3', lineHeight: 17, marginTop: 4 },

  /* Slider */
  sliderWrap: { marginBottom: 14 },
  slideCard: {
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 102,
    shadowColor: '#1E40AF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  slideAccent: { width: 34, height: 4, borderRadius: 999, marginBottom: 8 },
  slideTitle: { fontSize: 15, fontWeight: '800', color: colors.text, marginBottom: 5 },
  slideDesc: { fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  dotRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 9 },
  dot: { width: 7, height: 7, borderRadius: 999, backgroundColor: '#BFDBFE' },
  dotActive: { width: 20, backgroundColor: '#2563EB' },

  /* Card */
  card: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: 12,
    padding: isCompact ? 16 : 20,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.17,
    shadowRadius: 18,
    elevation: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomWidth: 4,
    borderBottomColor: colors.borderStrong,
  },
  cardTitle: { fontSize: 22, fontWeight: '900', color: colors.text, marginBottom: 4, letterSpacing: -0.4 },
  cardSub: { fontSize: 13, color: colors.textMuted, marginBottom: 18 },
  infoPanel: {
    borderRadius: 18,
    padding: 16,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16,
  },
  infoBadge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    backgroundColor: colors.infoSoft,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: 10,
  },
  infoBadgeText: { fontSize: 11, color: colors.info, fontWeight: '800', letterSpacing: 0.3 },
  infoTitle: { fontSize: 16, fontWeight: '800', color: colors.text, marginBottom: 6 },
  infoBody: { fontSize: 13, lineHeight: 20, color: colors.textSecondary },
  emailChip: {
    marginTop: 12,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  emailChipText: { fontSize: 13, color: colors.text, fontWeight: '700' },

  /* Icon circle */
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#EEF2FF',
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  iconEmoji: { fontSize: 26 },

  /* Step indicator */
  stepRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 6 },
  stepDot: { width: 32, height: 4, borderRadius: 999, backgroundColor: '#E2E8F0' },
  stepActive: { backgroundColor: '#2563EB' },
  stepDone: { backgroundColor: '#0EA5E9' },
  stepLabel: { fontSize: 12, color: '#6B7280', marginLeft: 6, fontWeight: '600' },

  /* Fields */
  fieldWrap: { marginBottom: 14 },
  fieldLabel: { fontSize: 12, fontWeight: '800', color: colors.textSecondary, marginBottom: 7 },
  textInput: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: 9,
    paddingHorizontal: 16,
    paddingVertical: 13,
    fontSize: 15,
    color: colors.text,
  },
  pwRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderRadius: 9,
  },
  pwInput: { flex: 1, paddingHorizontal: 16, paddingVertical: 13, fontSize: 15, color: colors.text },
  eyeBtn: { paddingHorizontal: 16, paddingVertical: 14 },
  eyeText: { fontSize: 13, color: colors.accent, fontWeight: '800' },

  /* Error / Success */
  errorBox: {
    backgroundColor: '#FEE2E2',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#FCA5A5',
  },
  errorText: { color: '#DC2626', fontSize: 14, textAlign: 'center' },
  successBox: {
    backgroundColor: '#DCFCE7',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#86EFAC',
  },
  successText: { color: '#166534', fontSize: 14, textAlign: 'center' },

  /* Buttons */
  btnPrimary: {
    backgroundColor: colors.accent,
    borderRadius: 9,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 6,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  btnPrimaryTxt: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
  btnOutline: {
    borderRadius: 16,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 6,
    borderWidth: 1.5,
    borderColor: colors.accent,
    backgroundColor: 'transparent',
  },
  btnOutlineTxt: { color: colors.accent, fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
  btnOff: { opacity: 0.7 },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 2 },

  /* Links */
  forgotLink: { alignSelf: 'flex-end', marginBottom: 4, marginTop: -4 },
  forgotText: { fontSize: 13, color: colors.accent, fontWeight: '700' },
  switchRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 16 },
  switchLabel: { fontSize: 13, color: colors.textMuted },
  switchLink: { fontSize: 13, color: colors.accent, fontWeight: '800' },
  resendBtn: { alignItems: 'center', marginTop: 14 },
  resendText: { fontSize: 13, color: colors.accent, fontWeight: '700' },
});

export default AuthScreen;
