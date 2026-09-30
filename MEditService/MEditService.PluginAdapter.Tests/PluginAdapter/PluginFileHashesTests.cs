using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

/// <summary>A plugin file's hash, asked of real files. A handle that denies sharing makes a read fail,
/// so a hash answered while one is open was answered without a read.</summary>
public sealed class PluginFileHashesTests : IDisposable
{
    private const string PluginName = "Stamped.esp";

    // A DateTime holds 100 ns and a file's own time can be finer, so a time set back to its own value
    // is set back to this one.
    private static readonly DateTime Modified = new(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc);

    private readonly PluginFixtureData _data = new PluginFixtureBuilder("adapter-file-hashes")
        .WithPlugin(PluginName)
        .Build();

    private string PluginPath => Path.Combine(_data.DataFolder, PluginName);

    public void Dispose() => _data.Dispose();

    private static PluginFileHashes WithTheClockPastEveryWrite() =>
        new(new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1)));

    private FileStream HeldAgainstReaders()
    {
        var held = new FileStream(PluginPath, FileMode.Open, FileAccess.Read, FileShare.None);
        Assert.Null(PluginBinaryHash.OfFile(PluginPath));
        return held;
    }

    [Fact]
    public void AnUnchangedFile_KeepsItsHashWithoutARead()
    {
        var hashes = WithTheClockPastEveryWrite();
        var first = hashes.Of(PluginPath);

        using var held = HeldAgainstReaders();

        Assert.NotNull(first);
        Assert.Equal(first, hashes.Of(PluginPath));
    }

    [Fact]
    public void AnotherInstance_ReadsTheFile()
    {
        WithTheClockPastEveryWrite().Of(PluginPath);

        using var held = HeldAgainstReaders();

        Assert.Null(WithTheClockPastEveryWrite().Of(PluginPath));
    }

    // Tools set modification time, so a rewrite of the same size can leave it as it was.
    [Fact]
    public void ARewriteThatKeepsSizeAndModificationTime_IsHashedAgain()
    {
        var hashes = WithTheClockPastEveryWrite();
        var rewritten = File.ReadAllBytes(PluginPath);
        rewritten[^1] ^= 0xFF;
        File.SetLastWriteTimeUtc(PluginPath, Modified);
        hashes.Of(PluginPath);

        File.WriteAllBytes(PluginPath, rewritten);
        File.SetLastWriteTimeUtc(PluginPath, Modified);

        Assert.Equal(PluginBinaryHash.OfBytes(rewritten), hashes.Of(PluginPath));
    }

    [Fact]
    public void AFileWhoseModificationTimeIsSetToItsOwnValue_IsReadAgain()
    {
        var hashes = WithTheClockPastEveryWrite();
        File.SetLastWriteTimeUtc(PluginPath, Modified);
        hashes.Of(PluginPath);

        File.SetLastWriteTimeUtc(PluginPath, Modified);
        using var held = HeldAgainstReaders();

        Assert.Null(hashes.Of(PluginPath));
    }

    // A file system's clock ticks coarsely, so a write in the same tick as the hash can leave the
    // stamp unchanged.
    [Fact]
    public void AFileChangedJustBeforeItsHash_IsReadAgain()
    {
        var hashes = new PluginFileHashes(TimeProvider.System);
        hashes.Of(PluginPath);

        using var held = HeldAgainstReaders();

        Assert.Null(hashes.Of(PluginPath));
    }
}
