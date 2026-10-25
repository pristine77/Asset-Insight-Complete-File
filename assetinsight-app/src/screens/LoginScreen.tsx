import React, { useEffect, useRef, useState } from 'react';
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
  Alert,
  Image,
  Linking,
  Animated,
  useWindowDimensions,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';

const BrandIcon = require('../../assets/icon.png');

const LOGIN_SLIDES = [
  {
    title: 'Track Leads Faster',
    description: 'See upcoming and overdue CRM tasks in one clean dashboard.',
    accent: '#0284C7',
  },
  {
    title: 'Action in Seconds',
    description: 'Call, email, and update lead status directly from your mobile workflow.',
    accent: '#0EA5E9',
  },
  {
    title: 'Stay on Schedule',
    description: 'Use reminders and notifications so no follow-up is missed.',
    accent: '#2563EB',
  },
];

const LoginScreen = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [activeSlide, setActiveSlide] = useState(0);
  const { login, loading, error, clearError } = useAuth();
  const { width } = useWindowDimensions();

  const sliderRef = useRef<ScrollView | null>(null);
  const heroAnim = useRef(new Animated.Value(0)).current;
  const formAnim = useRef(new Animated.Value(0)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  const isCompact = width < 380;
  const sliderWidth = Math.min(width - 40, 430);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(heroAnim, {
        toValue: 1,
        duration: 520,
        useNativeDriver: true,
      }),
      Animated.timing(formAnim, {
        toValue: 1,
        duration: 620,
        useNativeDriver: true,
      }),
    ]).start();
  }, [formAnim, heroAnim]);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowAnim, { toValue: 1, duration: 2400, useNativeDriver: true }),
        Animated.timing(glowAnim, { toValue: 0, duration: 2400, useNativeDriver: true }),
      ])
    );

    loop.start();
    return () => loop.stop();
  }, [glowAnim]);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveSlide((prev) => {
        const next = (prev + 1) % LOGIN_SLIDES.length;
        sliderRef.current?.scrollTo({ x: next * sliderWidth, y: 0, animated: true });
        return next;
      });
    }, 3800);

    return () => clearInterval(interval);
  }, [sliderWidth]);

  const handleSlideEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nextIndex = Math.round(event.nativeEvent.contentOffset.x / sliderWidth);
    setActiveSlide(Math.max(0, Math.min(LOGIN_SLIDES.length - 1, nextIndex)));
  };

  const openCreateAccount = async () => {
    const url = 'https://assetinsightvaluation.com';
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (!canOpen) {
        Alert.alert('Unable to open', 'Please visit assetinsightvaluation.com in your browser.');
        return;
      }
      await Linking.openURL(url);
    } catch {
      Alert.alert('Unable to open', 'Please visit assetinsightvaluation.com in your browser.');
    }
  };

  const handleLogin = async () => {
    if (!email.trim()) {
      Alert.alert('Error', 'Please enter your email');
      return;
    }
    if (!password) {
      Alert.alert('Error', 'Please enter your password');
      return;
    }

    try {
      clearError();
      await login({ email: email.trim().toLowerCase(), password });
    } catch (err: any) {
      Alert.alert('Login Failed', err.message || 'Please try again');
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.bgLayer} pointerEvents="none">
        <Animated.View
          style={[
            styles.bgBlobOne,
            {
              opacity: glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.8] }),
              transform: [
                {
                  scale: glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.95, 1.1] }),
                },
              ],
            },
          ]}
        />
        <Animated.View
          style={[
            styles.bgBlobTwo,
            {
              opacity: glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.65] }),
              transform: [
                {
                  scale: glowAnim.interpolate({ inputRange: [0, 1], outputRange: [1.05, 0.92] }),
                },
              ],
            },
          ]}
        />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboardView}>
        <ScrollView
          contentContainerStyle={[styles.scrollContent, isCompact && styles.scrollContentCompact]}
          keyboardShouldPersistTaps="handled">
          <Animated.View
            style={[
              styles.header,
              {
                opacity: heroAnim,
                transform: [
                  {
                    translateY: heroAnim.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }),
                  },
                ],
              },
            ]}>
            <View style={styles.brandPill}>
              <Text style={styles.brandPillText}>CRM Workspace</Text>
            </View>
            <View style={styles.logoFrame}>
              <Image source={BrandIcon} style={styles.logoImage} resizeMode="contain" />
            </View>
            <Text style={[styles.title, isCompact && styles.titleCompact]}>Welcome to Asset Insight</Text>
            <Text style={styles.subtitle}>Modern appraisal and CRM workflow for your team.</Text>
          </Animated.View>

          <View style={styles.sliderContainer}>
            <ScrollView
              ref={sliderRef}
              horizontal
              pagingEnabled
              showsHorizontalScrollIndicator={false}
              onMomentumScrollEnd={handleSlideEnd}
              decelerationRate="fast"
              scrollEventThrottle={16}>
              {LOGIN_SLIDES.map((slide) => (
                <View key={slide.title} style={[styles.slideCard, { width: sliderWidth }]}>
                  <View style={[styles.slideAccent, { backgroundColor: slide.accent }]} />
                  <Text style={styles.slideTitle}>{slide.title}</Text>
                  <Text style={styles.slideDescription}>{slide.description}</Text>
                </View>
              ))}
            </ScrollView>
            <View style={styles.dotRow}>
              {LOGIN_SLIDES.map((slide, index) => (
                <View
                  key={slide.title}
                  style={[styles.dot, index === activeSlide ? styles.dotActive : null]}
                />
              ))}
            </View>
          </View>

          <Animated.View
            style={[
              styles.form,
              {
                opacity: formAnim,
                transform: [
                  {
                    translateY: formAnim.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }),
                  },
                ],
              },
            ]}>
            <Text style={styles.welcomeText}>Welcome Back</Text>
            <Text style={styles.instructionText}>Sign in to continue</Text>

            {/* Email Input */}
            <View style={styles.inputContainer}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter your email"
                placeholderTextColor="#9CA3AF"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!loading}
              />
            </View>

            {/* Password Input */}
            <View style={styles.inputContainer}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.passwordContainer}>
                <TextInput
                  style={styles.passwordInput}
                  placeholder="Enter your password"
                  placeholderTextColor="#9CA3AF"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  editable={!loading}
                />
                <TouchableOpacity
                  onPress={() => setShowPassword(!showPassword)}
                  style={styles.eyeButton}>
                  <Text style={styles.eyeText}>{showPassword ? 'Hide' : 'Show'}</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Error Message */}
            {error && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            {/* Login Button */}
            <TouchableOpacity
              style={[styles.loginButton, loading && styles.loginButtonDisabled]}
              onPress={handleLogin}
              disabled={loading}>
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.loginButtonText}>Sign In</Text>
              )}
            </TouchableOpacity>

            <View style={styles.footer}>
              <Text style={styles.footerText}>Need a new account?</Text>
              <TouchableOpacity
                style={styles.createAccountButton}
                onPress={() => void openCreateAccount()}
                activeOpacity={0.9}>
                <Text style={styles.createAccountTitle}>Create account on Asset Insight Web</Text>
                <Text style={styles.createAccountSubtitle}>assetinsightvaluation.com</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#EDF2FF',
  },
  bgLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  bgBlobOne: {
    position: 'absolute',
    width: 230,
    height: 230,
    borderRadius: 999,
    backgroundColor: '#93C5FD',
    top: -64,
    right: -40,
  },
  bgBlobTwo: {
    position: 'absolute',
    width: 240,
    height: 240,
    borderRadius: 999,
    backgroundColor: '#BFDBFE',
    bottom: -88,
    left: -70,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingVertical: 24,
  },
  scrollContentCompact: {
    paddingVertical: 16,
  },
  header: {
    alignItems: 'center',
    marginBottom: 16,
  },
  brandPill: {
    borderRadius: 999,
    backgroundColor: '#DBEAFE',
    borderWidth: 1,
    borderColor: '#BFDBFE',
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginBottom: 12,
  },
  brandPillText: {
    color: '#1D4ED8',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  logoFrame: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#1D4ED8',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.22,
    shadowRadius: 14,
    elevation: 8,
    marginBottom: 1,
  },
  logoImage: {
    width: 82,
    height: 82,
  },
  title: {
    fontSize: 31,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 4,
    letterSpacing: -0.6,
    textAlign: 'center',
  },
  titleCompact: {
    fontSize: 27,
  },
  subtitle: {
    fontSize: 13,
    color: '#475569',
    textAlign: 'center',
    maxWidth: 310,
  },
  sliderContainer: {
    marginBottom: 14,
  },
  slideCard: {
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderWidth: 1,
    borderColor: '#DBEAFE',
    minHeight: 102,
    shadowColor: '#1E40AF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  slideAccent: {
    width: 34,
    height: 4,
    borderRadius: 999,
    marginBottom: 8,
  },
  slideTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 5,
  },
  slideDescription: {
    fontSize: 12,
    color: '#475569',
    lineHeight: 17,
  },
  dotRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
    marginTop: 9,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: '#BFDBFE',
  },
  dotActive: {
    width: 20,
    backgroundColor: '#2563EB',
  },
  form: {
    backgroundColor: 'rgba(255,255,255,0.98)',
    borderRadius: 24,
    padding: 22,
    shadowColor: '#1E3A8A',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.17,
    shadowRadius: 18,
    elevation: 10,
    borderWidth: 1,
    borderColor: 'rgba(37, 99, 235, 0.15)',
  },
  welcomeText: {
    fontSize: 24,
    fontWeight: '800',
    color: '#0F172A',
    marginBottom: 4,
    letterSpacing: -0.5,
  },
  instructionText: {
    fontSize: 14,
    color: '#6B7280',
    marginBottom: 20,
  },
  inputContainer: {
    marginBottom: 14,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 7,
  },
  input: {
    backgroundColor: '#F9FAFB',
    borderWidth: 1.5,
    borderColor: '#D1D5DB',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 13,
    fontSize: 15,
    color: '#1F2937',
  },
  passwordContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderWidth: 1.5,
    borderColor: '#D1D5DB',
    borderRadius: 14,
  },
  passwordInput: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 13,
    fontSize: 15,
    color: '#1F2937',
  },
  eyeButton: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  eyeText: {
    fontSize: 14,
    color: '#2563EB',
    fontWeight: '600',
  },
  errorContainer: {
    backgroundColor: '#FEE2E2',
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#FCA5A5',
    shadowColor: '#DC2626',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  errorText: {
    color: '#DC2626',
    fontSize: 14,
    textAlign: 'center',
  },
  loginButton: {
    backgroundColor: '#2563EB',
    borderRadius: 16,
    paddingVertical: 15,
    alignItems: 'center',
    marginTop: 6,
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  loginButtonDisabled: {
    opacity: 0.7,
  },
  loginButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  footer: {
    marginTop: 16,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 13,
    color: '#6B7280',
    marginBottom: 10,
  },
  createAccountButton: {
    width: '100%',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#C7D2FE',
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  createAccountTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1E3A8A',
  },
  createAccountSubtitle: {
    marginTop: 2,
    fontSize: 12,
    color: '#4338CA',
    fontWeight: '600',
  },
});

export default LoginScreen;
