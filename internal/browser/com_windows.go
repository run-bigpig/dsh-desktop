package browser

import (
	"fmt"
	"golang.org/x/sys/windows"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"
)

// Vtables follow Microsoft.Web.WebView2 SDK 1.0.4191.47.
type com struct{ table *[128]uintptr }

func (c *com) call(index int, args ...uintptr) error {
	args = append([]uintptr{uintptr(unsafe.Pointer(c))}, args...)
	r, _, _ := syscall.SyscallN(c.table[index], args...)
	if int32(r) < 0 {
		return fmt.Errorf("COM method %d: HRESULT 0x%08x", index, uint32(r))
	}
	return nil
}

func ptr[T any](v *T) uintptr { return uintptr(unsafe.Pointer(v)) }
func wide(s string) *uint16   { return windows.StringToUTF16Ptr(s) }

type callback struct {
	table  *[4]uintptr
	refs   atomic.Int32
	invoke func(uintptr, uintptr)
	iid    windows.GUID
}

// COM owns callbacks asynchronously. Keep Go roots until the last Release.
var callbackRoots = struct {
	sync.Mutex
	values map[*callback]struct{}
}{values: make(map[*callback]struct{})}
var callbackTable = [4]uintptr{
	syscall.NewCallback(func(self, iid, out uintptr) uintptr {
		c := (*callback)(unsafe.Pointer(self))
		want := *(*windows.GUID)(unsafe.Pointer(iid))
		unknown, _ := windows.GUIDFromString("{00000000-0000-0000-C000-000000000046}")
		if want != c.iid && want != unknown {
			*(*uintptr)(unsafe.Pointer(out)) = 0
			return 0x80004002
		}
		*(*uintptr)(unsafe.Pointer(out)) = self
		(*callback)(unsafe.Pointer(self)).refs.Add(1)
		return 0
	}),
	syscall.NewCallback(func(self uintptr) uintptr { return uintptr((*callback)(unsafe.Pointer(self)).refs.Add(1)) }),
	syscall.NewCallback(func(self uintptr) uintptr { return (*callback)(unsafe.Pointer(self)).release() }),
	syscall.NewCallback(func(self, result, value uintptr) uintptr {
		(*callback)(unsafe.Pointer(self)).invoke(result, value)
		return 0
	}),
}

func completed(iid string, fn func(uintptr, uintptr)) *callback {
	id, err := windows.GUIDFromString(iid)
	if err != nil {
		panic(err)
	}
	c := &callback{table: &callbackTable, invoke: fn, iid: id}
	c.refs.Store(1)
	callbackRoots.Lock()
	callbackRoots.values[c] = struct{}{}
	callbackRoots.Unlock()
	return c
}

func (c *callback) release() uintptr {
	refs := c.refs.Add(-1)
	if refs == 0 {
		callbackRoots.Lock()
		delete(callbackRoots.values, c)
		callbackRoots.Unlock()
	}
	return uintptr(refs)
}
