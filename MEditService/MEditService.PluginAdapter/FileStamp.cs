using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace MEditService.PluginAdapter;

/// <summary>What the file system says of a file without a read of its bytes. Times are nanoseconds
/// since the Unix epoch. .NET exposes no change time, so each platform's is read natively.</summary>
internal readonly record struct FileStamp(long Size, long Modified, long Changed)
{
    /// <summary>Null when the file system cannot answer, and then nothing vouches for a remembered
    /// hash.</summary>
    public static FileStamp? Of(string path) =>
        OperatingSystem.IsWindows() ? WindowsFileStamp.Of(path) : LinuxFileStamp.Of(path);

    public bool ChangedBefore(DateTimeOffset moment) =>
        Changed < (moment - DateTimeOffset.UnixEpoch).Ticks * (1_000_000_000 / TimeSpan.TicksPerSecond);
}

internal static class LinuxFileStamp
{
    private const int CurrentDirectory = -100;
    private const uint ModifiedMask = 0x40;
    private const uint ChangedMask = 0x80;
    private const uint SizeMask = 0x200;
    private const uint Wanted = SizeMask | ModifiedMask | ChangedMask;

    // struct statx from the kernel's uapi <linux/stat.h>: fixed-width fields, the same layout on
    // every architecture.
    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct Statx
    {
        [FieldOffset(0)] public uint Mask;
        [FieldOffset(40)] public ulong Size;
        [FieldOffset(96)] public long ChangedSeconds;
        [FieldOffset(104)] public uint ChangedNanoseconds;
        [FieldOffset(112)] public long ModifiedSeconds;
        [FieldOffset(120)] public uint ModifiedNanoseconds;
    }

    // The path as the kernel takes it: UTF-8 with a terminating null.
    [DllImport("libc", EntryPoint = "statx")]
    private static extern int StatxOf(int directory, byte[] path, int flags, uint mask, out Statx result);

    public static FileStamp? Of(string path)
    {
        var answered = StatxOf(CurrentDirectory, Encoding.UTF8.GetBytes(path + '\0'), 0, Wanted, out var stat) == 0;
        if (!answered || (stat.Mask & Wanted) != Wanted) return null;
        return new FileStamp(
            (long)stat.Size,
            Nanoseconds(stat.ModifiedSeconds, stat.ModifiedNanoseconds),
            Nanoseconds(stat.ChangedSeconds, stat.ChangedNanoseconds));
    }

    private static long Nanoseconds(long seconds, uint nanoseconds) => (seconds * 1_000_000_000) + nanoseconds;
}

internal static class WindowsFileStamp
{
    // Attributes alone: an open for them passes a tool's handle that denies sharing.
    private const uint ReadAttributes = 0x80;
    private const uint ShareReadWriteDelete = 0x7;
    private const uint OpenExisting = 3;
    private const int FileBasicInfoClass = 0;
    private const long UnixEpochAsFileTime = 116_444_736_000_000_000;

    // FILE_BASIC_INFO from <winbase.h>.
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    private struct FileBasicInfo
    {
        [FieldOffset(16)] public long Modified;
        [FieldOffset(24)] public long Changed;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW")]
    private static extern SafeFileHandle CreateFile(
        [MarshalAs(UnmanagedType.LPWStr)] string path, uint access, uint share, nint security, uint disposition,
        uint flags, nint template);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file, int infoClass, out FileBasicInfo info, uint size);

    public static FileStamp? Of(string path)
    {
        using var file = CreateFile(path, ReadAttributes, ShareReadWriteDelete, 0, OpenExisting, 0, 0);
        if (file.IsInvalid
            || !GetFileInformationByHandleEx(file, FileBasicInfoClass, out var info, (uint)Marshal.SizeOf<FileBasicInfo>()))
        {
            return null;
        }
        return new FileStamp(
            RandomAccess.GetLength(file), Nanoseconds(info.Modified), Nanoseconds(info.Changed));
    }

    private static long Nanoseconds(long fileTime) => (fileTime - UnixEpochAsFileTime) * 100;
}
