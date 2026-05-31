import type { GlobalThemeOverrides } from 'naive-ui'

const bodyColor = 'rgb(16, 16, 20)'
const floatingSurfaceColor = 'rgb(22, 22, 26)'
const floatingBoxShadow = '0 0 0 1px rgba(255, 255, 255, 0.08), 0 8px 24px -4px rgba(0, 0, 0, 0.5)'
const floatingBorderRadius = '6px'
const floatingOptionHoverColor = 'rgba(255, 255, 255, 0.08)'
const cardColor = 'rgb(24, 24, 28)'

export const adminThemeOverrides: GlobalThemeOverrides = {
  common: {
    bodyColor: bodyColor,
    primaryColor: '#0a84ff',
    primaryColorHover: '#409cff',
    primaryColorPressed: '#0066cc',
    primaryColorSuppl: '#0a84ff',
    cardColor: cardColor,
    actionColor: 'rgba(255, 255, 255, 0.04)',
    hoverColor: 'rgba(255, 255, 255, 0.06)',
    pressedColor: 'rgba(255, 255, 255, 0.05)',
    borderColor: 'rgba(255, 255, 255, 0.24)',
    dividerColor: 'rgba(255, 255, 255, 0.09)',
  },
  Badge: {
    fontSize: '10px',
  },
  Button: {
    paddingSmall: '0 10px',
    iconSizeSmall: '16px',
    iconMarginSmall: '6px',
  },
  Menu: {
    itemHeight: '28px',
    fontSize: '13px',
  },
  Layout: {
    headerColor: bodyColor,
  },
  DataTable: {
    thPaddingSmall: '4px 8px',
    tdPaddingSmall: '4px 8px',
    tdColorHover: 'rgba(255, 255, 255, 0.005)',
    tdColorHoverModal: 'rgba(255, 255, 255, 0.03)',
    tdColorHoverPopover: 'rgba(255, 255, 255, 0.03)',
    tdColorSorting: cardColor,
    tdColorSortingModal: cardColor,
    tdColorSortingPopover: cardColor,
    thColorSorting: 'rgba(255, 255, 255, 0.04)',
    thColorSortingModal: 'rgba(255, 255, 255, 0.04)',
    thColorSortingPopover: 'rgba(255, 255, 255, 0.04)',
  },
  Input: {
    paddingSmall: '0 6px',
    color: 'rgba(255, 255, 255, 0.05)',
    colorFocus: 'rgba(255, 255, 255, 0.1)',
    border: '1px solid transparent',
    borderRadius: '10px',
    borderHover: '1px solid rgba(255, 255, 255, 0.15)',
    borderFocus: '1px solid rgba(255, 255, 255, 0.2)',
    boxShadowFocus: 'none',
  },
  InternalSelectMenu: {
    color: floatingSurfaceColor,
    menuBoxShadow: floatingBoxShadow,
    borderRadius: floatingBorderRadius,
    optionColorHover: floatingOptionHoverColor,
    optionColorActive: floatingOptionHoverColor,
    optionHeightSmall: '28px',
    optionFontSizeSmall: '13px',
    optionHeightMedium: '28px',
    optionFontSizeMedium: '13px',
    paddingSmall: '4px 0',
    paddingMedium: '4px 0',
  },
  Divider: {},
  Dropdown: {
    color: floatingSurfaceColor,
    borderRadius: floatingBorderRadius,
    optionColorHover: floatingOptionHoverColor,
    optionColorActive: floatingOptionHoverColor,
    dividerColor: 'rgba(255, 255, 255, 0.08)',
    optionHeightSmall: '28px',
    fontSizeSmall: '13px',
    optionHeightMedium: '28px',
    fontSizeMedium: '13px',
    padding: '4px 0',
  },
  Popover: {
    color: floatingSurfaceColor,
    boxShadow: floatingBoxShadow,
    borderRadius: floatingBorderRadius,
  },
  Tooltip: {
    padding: '2px 6px',
    color: 'rgba(12, 12, 15, 0.95)',
    textColor: 'rgba(255, 255, 255, 0.85)',
    boxShadow: '0 4px 12px -2px rgba(0, 0, 0, 0.8)',
  },
}
