#!/bin/sh
# Refuses to start the Incus daemon service unless the filesystem mounted at the
# state directory is the recorded state dataset of the recorded pool. The
# argument is the root-owned expectation file. The check reads the kernel mount
# table, the imported pool listing, and the dataset GUID. It never installs,
# imports, mounts, repairs, or queries Incus. Directory existence and unit
# ordering are not identity, so neither is consulted. Every refusal exits 255,
# which makes a systemd ExecCondition fail the unit instead of skipping it.
LC_ALL=C
export LC_ALL
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

refuse() {
  echo "qiln: Incus start refused: $1" >&2
  exit 255
}

test $# -eq 1 || refuse 'the expectation file was not named'
expectation=$1
test -f "$expectation" && test ! -L "$expectation" || refuse 'the expectation file is missing'

layout=
pool=
pool_guid=
state_dataset=
state_guid=
mountpoint=
while IFS='=' read -r key value; do
  case $key in
  layout) layout=$value ;;
  pool) pool=$value ;;
  poolGuid) pool_guid=$value ;;
  stateDataset) state_dataset=$value ;;
  stateGuid) state_guid=$value ;;
  mountpoint) mountpoint=$value ;;
  esac
done < "$expectation"

test "$layout" = 1 || refuse 'the expectation file names an unsupported layout'
case $pool in '' | *[!a-z0-9_-]*) refuse 'the expectation file has no valid pool name' ;; esac
case $pool_guid in '' | *[!0-9]*) refuse 'the expectation file has no valid pool GUID' ;; esac
case $state_guid in '' | *[!0-9]*) refuse 'the expectation file has no valid state dataset GUID' ;; esac
test -n "$state_dataset" || refuse 'the expectation file has no state dataset'
case $mountpoint in /*) ;; *) refuse 'the expectation file has no valid state directory' ;; esac

mounted_from=$(findmnt --kernel --noheadings --mountpoint "$mountpoint" --output SOURCE 2>/dev/null) || refuse 'nothing is mounted at the state directory'
mounted_type=$(findmnt --kernel --noheadings --mountpoint "$mountpoint" --output FSTYPE 2>/dev/null) || refuse 'nothing is mounted at the state directory'
test "$mounted_from" = "$state_dataset" && test "$mounted_type" = zfs || refuse 'the state directory is not the recorded state dataset'

imported=$(zpool list -H -o name,guid 2>/dev/null) || refuse 'the imported pools could not be listed'
printf '%s\n' "$imported" | grep -Fxq "$(printf '%s\t%s' "$pool" "$pool_guid")" || refuse 'the recorded pool is not imported with its recorded GUID'

actual=$(zfs get -H -p -o value guid "$state_dataset" 2>/dev/null) || refuse 'the state dataset GUID could not be read'
test "$actual" = "$state_guid" || refuse 'the state dataset does not have its recorded GUID'
exit 0
