import { entry } from './define'

export const hostDiagnostics = Object.freeze({
  MISSING_HOST_TOOL: entry(
    'Required host tool is unavailable',
    'Qiln uses tools already installed on the host. It does not install packages or invoke privilege escalation.',
    'Install the indicated package manually after review, then return to an unprivileged developer session.',
  ),
  PACKAGE_QUERY_FAILED: entry(
    'Installed package could not be inspected',
    'The package query did not establish whether the required package is installed and compatible.',
    'Inspect and repair the local dpkg package database manually.',
  ),
  PACKAGE_VERSION_CHECK_FAILED: entry(
    'Incus package version could not be compared',
    'Qiln could not establish whether the installed package is within its supported version range.',
    'Inspect the local dpkg installation and repair its package metadata manually.',
  ),
  INCUS_PACKAGE_MISSING: entry(
    'Supported Incus server package is missing',
    'Qiln requires a preinstalled Incus server and does not bootstrap the host daemon.',
    'Install a supported Incus server through the reviewed Ubuntu or Zabbly procedure.',
    'Enable the service manually and start a new login session if group membership changes.',
  ),
  UNSUPPORTED_INCUS_PACKAGE_VERSION: entry(
    'Incus package version is unsupported',
    'The installed package is outside the installer’s supported range. Package metadata alone does not establish publisher provenance.',
    'Review the package source and manually install a supported Incus release.',
  ),
  UNSUPPORTED_HOST_PLATFORM: entry(
    'Host platform is unsupported',
    'The local Incus, ZFS, and Unix-socket installation boundary requires Linux.',
    'Run Qiln on the supported Ubuntu developer host.',
  ),
  HOST_RELEASE_UNAVAILABLE: entry(
    'Host release could not be identified',
    'Qiln must establish the supported operating-system release before running dependent checks.',
    'Restore readable, valid /etc/os-release metadata on the supported Ubuntu host.',
  ),
  UNSUPPORTED_UBUNTU_RELEASE: entry(
    'Ubuntu release is unsupported',
    'The installer deliberately accepts only its configured Ubuntu release.',
    'Use the supported host release shown in the diagnostic facts.',
  ),
  UNSUPPORTED_HOST_ARCHITECTURE: entry(
    'Host architecture is unsupported',
    'The installer supports native AMD64 and ARM64 hosts, and requires the package, machine, and Node architectures to agree. It does not rely on foreign-architecture emulation.',
    'Run Qiln on a supported amd64/x86_64 or arm64/aarch64 host with a matching Node runtime.',
  ),
  UNSUPPORTED_KERNEL_VERSION: entry(
    'Running kernel does not meet the installation policy',
    'The selected Incus release and installation policy require the configured kernel baseline.',
    'Manually install and boot an approved kernel that meets the requirement.',
  ),
  HOST_NETWORK_INSPECTION_FAILED: entry(
    'Host network information could not be decoded',
    'Qiln could not establish whether the planned subnet conflicts with host routes or addresses.',
    'Inspect the host network configuration and repair the iproute2 installation if necessary.',
  ),
  HOST_ROUTE_INSPECTION_FAILED: entry(
    'Host IPv4 routes could not be inspected',
    'Qiln cannot establish that the planned bridge range is free of host routing conflicts.',
    'Inspect host networking and the iproute2 installation manually.',
  ),
  HOST_ROUTE_RANGE_CONFLICT: entry(
    'Planned subnet overlaps a host route',
    'The installer-owned bridge would conflict with existing host routing.',
    'Review the route and network ownership manually. Qiln will not alter routes or implicitly choose another range.',
  ),
  HOST_ADDRESS_INSPECTION_FAILED: entry(
    'Host IPv4 addresses could not be inspected',
    'Qiln cannot establish that the planned gateway and subnet are free of address conflicts.',
    'Inspect host networking and the iproute2 installation manually.',
  ),
  HOST_ADDRESS_RANGE_CONFLICT: entry(
    'Planned subnet overlaps a host address',
    'The bridge gateway and DHCP range must not collide with another host network.',
    'Review and reconfigure the conflicting network manually.',
  ),
  HOST_ZFS_POOL_MISSING: entry(
    'Required host ZFS pool is unavailable',
    'Qiln does not create, import, format, repair, or reconfigure host ZFS pools.',
    'Have an operator provision or import the required pool manually and verify its health.',
  ),
  HOST_ZFS_POOL_UNHEALTHY: entry(
    'Required host ZFS pool is not healthy',
    'Qiln will not place persistent PostgreSQL data on an unhealthy or incompatible pool.',
    'Inspect zpool status and repair the pool manually.',
  ),
  HOST_ZFS_DATASET_UNAVAILABLE: entry(
    'Required ZFS root dataset is unavailable',
    'The Incus storage pool must be backed by the configured host zpool.',
    'Inspect the host pool and dataset hierarchy manually.',
  ),
  UNSUPPORTED_PLATFORM: entry(
    'Required user identity information is unavailable',
    'Qiln must establish the invoking user identity before using protected installer state or credentials.',
    'Run Qiln on the supported Ubuntu host as an unprivileged developer.',
  ),
  ROOT_EXECUTION_REFUSED: entry(
    'Qiln refuses to run as root',
    'Public installation commands must use only the unprivileged developer’s existing local authority.',
    'Leave the root shell and run Qiln as the authorized developer.',
    'Perform required host administration separately and manually.',
  ),
})
