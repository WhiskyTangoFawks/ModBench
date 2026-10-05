using MEditService.Codec.Serialization;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginFileHashesTests : IDisposable
{
    private const string PluginName = "Stamped.esp";

    private static readonly DateTime ModifiedOnAWholeDateTimeTick = new(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc);

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
    public void TheClaimOfAFile_CarriesTheHashOfTheBytesItScanned()
    {
        var claim = PluginBinaryHash.ClaimOfFile(PluginPath);

        Assert.Equal(PluginBinaryHash.OfFile(PluginPath), claim?.Hash);
        Assert.Empty(claim?.Diagnoses ?? [new PluginDiagnosis(null, "unscanned", null, "")]);
    }

    [Fact]
    public void TheClaimOfAFileHeldAgainstReaders_IsNull()
    {
        using var held = HeldAgainstReaders();

        Assert.Null(PluginBinaryHash.ClaimOfFile(PluginPath));
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

    [Fact]
    public void AToolsRewriteThatKeepsSizeAndModificationTime_IsHashedAgain()
    {
        var hashes = WithTheClockPastEveryWrite();
        var rewritten = File.ReadAllBytes(PluginPath);
        rewritten[^1] ^= 0xFF;
        File.SetLastWriteTimeUtc(PluginPath, ModifiedOnAWholeDateTimeTick);
        hashes.Of(PluginPath);

        File.WriteAllBytes(PluginPath, rewritten);
        File.SetLastWriteTimeUtc(PluginPath, ModifiedOnAWholeDateTimeTick);

        Assert.Equal(PluginBinaryHash.OfBytes(rewritten), hashes.Of(PluginPath));
    }

    [Fact]
    public void AFileWhoseModificationTimeIsSetToItsOwnValue_IsReadAgain()
    {
        var hashes = WithTheClockPastEveryWrite();
        File.SetLastWriteTimeUtc(PluginPath, ModifiedOnAWholeDateTimeTick);
        hashes.Of(PluginPath);

        File.SetLastWriteTimeUtc(PluginPath, ModifiedOnAWholeDateTimeTick);
        using var held = HeldAgainstReaders();

        Assert.Null(hashes.Of(PluginPath));
    }

    [Fact]
    public void AFileWhoseStampIsWithinTheClockTickOfItsHash_IsReadAgain()
    {
        var hashes = new PluginFileHashes(TimeProvider.System);
        hashes.Of(PluginPath);

        using var held = HeldAgainstReaders();

        Assert.Null(hashes.Of(PluginPath));
    }
}
