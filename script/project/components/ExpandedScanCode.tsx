import { GeometryReader, HStack, Image, QRImage, Rectangle, Text, VStack, ZStack, type VirtualNode } from "scripting";
import { bundledImage } from "./bundled-image";
import { PICKUP_CARD_SPACING } from "../services/parcel-card-appearance";

const CAPTION_ROOM = 64;
const SCAN_PANEL_INSET = 16;
const SCAN_QUIET_ZONE = 8;
const SCAN_PANEL_SHAPE = { type: "rect", cornerRadius: 24, style: "continuous" } as const;
const SCAN_TILE_SHAPE = { type: "rect", cornerRadius: 14, style: "continuous" } as const;

export function ScanCodeSurface({ closeLabel, onClose, followsSystemAppearance, children }: {
  closeLabel?: string;
  onClose?: () => void;
  followsSystemAppearance?: boolean;
  children: VirtualNode;
}) {
  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      preferredColorScheme={followsSystemAppearance ? undefined : "light"}
      contentShape="rect" onTapGesture={onClose}
      accessibilityActions={onClose && closeLabel ? [{ name: closeLabel, action: onClose }] : undefined}>
      <Rectangle fill={followsSystemAppearance ? "systemBackground" : "white"} ignoresSafeArea accessibilityHidden />
      {children}
    </ZStack>
  );
}

export function ScanCodeNumber({ value, prominent }: { value: string; prominent?: boolean }) {
  return <Text font={prominent ? "title2" : 14} fontWeight={prominent ? "semibold" : "medium"}
    fontDesign={prominent ? "monospaced" : undefined} foregroundStyle={prominent ? "label" : "#1C1C1E"} lineLimit={1}
    minScaleFactor={0.55}>{value}</Text>;
}

export function ScanCodeShrinkHint({ text = "点击可缩小", prominent }: { text?: string; prominent?: boolean }) {
  return <Text font={prominent ? "footnote" : 12} foregroundStyle={prominent ? "secondaryLabel" : "#636366"}>{text}</Text>;
}

function ScanCodeCaption({ number, footer, hint, prominent }: {
  number?: string; footer?: VirtualNode; hint?: string; prominent?: boolean;
}) {
  return (
    <VStack spacing={prominent ? 6 : 8}>
      {number ? <ScanCodeNumber value={number} prominent={prominent} /> : null}
      <ScanCodeShrinkHint text={hint} prominent={prominent} />
      {footer}
    </VStack>
  );
}

export function ExpandedQRCode({ data, title, titleLogo, number, footer, hint, header, close }: {
  data: string;
  title?: string;
  titleLogo?: string;
  number?: string;
  footer?: VirtualNode;
  hint?: string;
  header?: (width: number) => VirtualNode;
  close?: { label: string; action: () => void };
}) {
  const showsCard = Boolean(header);
  const horizontalInset = showsCard ? 16 : 24;
  const logo = bundledImage(titleLogo);
  const content = (width?: number) => (
    <VStack spacing={showsCard ? PICKUP_CARD_SPACING : 18} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      padding={{ horizontal: horizontalInset, vertical: 24 }}>
      {title ? (
        <HStack spacing={8}>
          {logo ? <Image image={logo} renderingMode="original" resizable scaleToFit
            frame={{ width: 24, height: 24 }} clipShape="circle" accessibilityHidden /> : null}
          <Text font="title3" fontWeight="semibold" foregroundStyle="label">{title}</Text>
        </HStack>
      ) : null}
      {width !== undefined && width > 0 ? header?.(width) : null}
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        contentShape="rect" onTapGesture={close?.action}
        background={showsCard ? {
          style: { light: "systemGroupedBackground", dark: "secondarySystemGroupedBackground" },
          shape: SCAN_PANEL_SHAPE,
        } : undefined}
        accessibilityActions={close ? [{ name: close.label, action: close.action }] : undefined}>
        <GeometryReader padding={showsCard ? { top: 48 } : undefined}>
          {({ size }) => {
            const inset = title ? 2 * (SCAN_PANEL_INSET + SCAN_QUIET_ZONE) : 0;
            const qrSize = Math.min(320, size.width - inset, size.height - inset - (title ? CAPTION_ROOM : 0));
            return (
              <VStack spacing={12} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
                {qrSize > 0 ? (
                  <VStack padding={title ? SCAN_QUIET_ZONE : 0}
                    background={title ? { style: "white", shape: SCAN_TILE_SHAPE } : undefined}>
                    <QRImage data={data} size={qrSize} />
                  </VStack>
                ) : null}
                {title ? <ScanCodeCaption number={number} hint={hint} prominent /> : null}
              </VStack>
            );
          }}
        </GeometryReader>
      </VStack>
      {title ? footer : <ScanCodeCaption number={number} footer={footer} hint={hint} />}
    </VStack>
  );
  return showsCard ? (
    <GeometryReader>{({ size }) => content(size.width - 2 * horizontalInset)}</GeometryReader>
  ) : content();
}
