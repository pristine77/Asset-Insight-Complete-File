import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';
import type { AppThemeColors } from '../../context/ThemeContext';

export type LotTrendPoint = {
  date: string;
  label: string;
  value: number;
};

type LotTrendChartProps = {
  data: LotTrendPoint[];
  colors: AppThemeColors;
};

const CHART_HEIGHT = 172;
const PADDING = { top: 24, right: 6, bottom: 30, left: 6 };

/**
 * A compact SVG bar chart keeps lot volume readable on mobile without adding a
 * heavyweight chart runtime. Values and dates are always visible without hover.
 */
export default function LotTrendChart({ data, colors }: LotTrendChartProps) {
  const [width, setWidth] = useState(0);
  const maxValue = useMemo(
    () => Math.max(1, ...data.map((point) => Math.max(0, point.value))),
    [data]
  );

  if (width <= 0) {
    return (
      <View
        style={styles.measureSurface}
        onLayout={(event) => setWidth(Math.floor(event.nativeEvent.layout.width))}
      />
    );
  }

  const plotWidth = Math.max(1, width - PADDING.left - PADDING.right);
  const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;
  const slotWidth = plotWidth / Math.max(1, data.length);
  const barWidth = Math.max(14, Math.min(34, slotWidth * 0.56));

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={data.map((point) => `${point.label}: ${point.value} lots`).join(', ')}
      style={styles.chart}
      onLayout={(event) => {
        const nextWidth = Math.floor(event.nativeEvent.layout.width);
        if (Math.abs(nextWidth - width) > 1) setWidth(nextWidth);
      }}>
      <Svg width={width} height={CHART_HEIGHT}>
        {[0, 0.5, 1].map((position) => {
          const y = PADDING.top + plotHeight * position;
          return (
            <Line
              key={position}
              x1={PADDING.left}
              x2={width - PADDING.right}
              y1={y}
              y2={y}
              stroke={colors.border}
              strokeWidth={1}
            />
          );
        })}

        {data.map((point, index) => {
          const normalized = Math.max(0, point.value) / maxValue;
          const visualHeight = point.value > 0 ? Math.max(5, normalized * plotHeight) : 2;
          const x = PADDING.left + slotWidth * index + (slotWidth - barWidth) / 2;
          const y = PADDING.top + plotHeight - visualHeight;
          const isLatest = index === data.length - 1;

          return (
            <React.Fragment key={point.date}>
              <Rect
                x={x}
                y={y}
                width={barWidth}
                height={visualHeight}
                rx={4}
                fill={isLatest ? colors.accent : colors.graphiteSoft}
              />
              <SvgText
                x={x + barWidth / 2}
                y={Math.max(11, y - 6)}
                fill={colors.text}
                fontSize={9}
                fontWeight="800"
                textAnchor="middle">
                {point.value}
              </SvgText>
              <SvgText
                x={x + barWidth / 2}
                y={CHART_HEIGHT - 8}
                fill={colors.textMuted}
                fontSize={8.5}
                fontWeight="700"
                textAnchor="middle">
                {point.label}
              </SvgText>
            </React.Fragment>
          );
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  measureSurface: { width: '100%', height: CHART_HEIGHT },
  chart: { width: '100%', height: CHART_HEIGHT },
});
