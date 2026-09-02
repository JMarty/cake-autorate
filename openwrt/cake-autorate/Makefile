include $(TOPDIR)/rules.mk

PKG_NAME:=cake-autorate
PKG_VERSION:=3.5.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only
PKG_LICENSE_FILES:=LICENCE.md
PKG_MAINTAINER:=janklovicsmarton

include $(INCLUDE_DIR)/package.mk

# The scripts live in the repository root, two levels above this Makefile.
SRC_ROOT:=$(CURDIR)/../..

define Package/cake-autorate
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Traffic Shaping
  TITLE:=Adaptive CAKE bandwidth controller
  URL:=https://github.com/lynxthecat/cake-autorate
  DEPENDS:=+bash +fping +sqm-scripts +jsonfilter
  PKGARCH:=all
endef

define Package/cake-autorate/description
  cake-autorate adjusts CAKE bandwidth on variable-rate links (LTE, 5G,
  Starlink, cable) from measured load and one-way delay / RTT.
  One procd instance per 'instance' section in /etc/config/cake-autorate.
endef

define Package/cake-autorate/conffiles
/etc/config/cake-autorate
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Configure
endef

define Build/Compile
endef

define Package/cake-autorate/install
	$(INSTALL_DIR) $(1)/usr/lib/cake-autorate
	$(INSTALL_BIN) $(SRC_ROOT)/cake-autorate.sh $(1)/usr/lib/cake-autorate/
	$(INSTALL_DATA) $(SRC_ROOT)/defaults.sh $(1)/usr/lib/cake-autorate/
	$(INSTALL_DATA) $(SRC_ROOT)/lib.sh $(1)/usr/lib/cake-autorate/
	$(INSTALL_BIN) $(SRC_ROOT)/mqtt-publisher.sh $(1)/usr/lib/cake-autorate/
	$(INSTALL_BIN) ./files/uci-to-config.sh $(1)/usr/lib/cake-autorate/
	$(INSTALL_BIN) ./files/migrate-legacy-config.sh $(1)/usr/lib/cake-autorate/
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/cake-autorate.init $(1)/etc/init.d/cake-autorate
	$(INSTALL_BIN) ./files/mqtt-publisher.init $(1)/etc/init.d/mqtt-publisher
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/cake-autorate.config $(1)/etc/config/cake-autorate
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/cake-autorate.defaults $(1)/etc/uci-defaults/99-cake-autorate-migrate
	$(INSTALL_DIR) $(1)/usr/libexec/rpcd
	$(INSTALL_BIN) ./files/rpcd-cake-autorate $(1)/usr/libexec/rpcd/cake-autorate
endef

$(eval $(call BuildPackage,cake-autorate))
