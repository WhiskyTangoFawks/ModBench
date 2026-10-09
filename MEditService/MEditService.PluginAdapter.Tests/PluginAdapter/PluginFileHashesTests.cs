using System.Security.Cryptography;
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

    private static string Sha256Hex(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private string PluginPath => Path.Combine(_data.DataFolder, PluginName);

    public void Dispose() => _data.Dispose();

    private static MutagenPluginAdapter WithTheClockPastEveryWrite() =>
        new(new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1)));

    private static PluginAnswer<FileClaim> ClaimOf(string path) => TestAdapters.Mutagen().ClaimOf(path);

    private FileStream HeldAgainstReaders()
    {
        var held = new FileStream(PluginPath, FileMode.Open, FileAccess.Read, FileShare.None);
        Assert.IsType<PluginFailure.Inaccessible>(ClaimOf(PluginPath).Failure());
        return held;
    }

    [Fact]
    public void TheClaimOfAFile_CarriesTheHashOfTheBytesItScanned()
    {
        var claim = ClaimOf(PluginPath).Answered();

        Assert.Equal(Sha256Hex(File.ReadAllBytes(PluginPath)), claim.Hash);
        Assert.Empty(claim.Diagnoses.Answered());
    }

    [Fact]
    public void TheClaimOfAFileHeldAgainstReaders_IsInaccessible()
    {
        using var held = HeldAgainstReaders();

        Assert.IsType<PluginFailure.Inaccessible>(ClaimOf(PluginPath).Failure());
    }

    [Fact]
    public void AnUnchangedFile_KeepsItsHashWithoutARead()
    {
        var hashes = WithTheClockPastEveryWrite();
        var first = hashes.HashOf(PluginPath);

        using var held = HeldAgainstReaders();

        Assert.NotNull(first);
        Assert.Equal(first, hashes.HashOf(PluginPath));
    }

    [Fact]
    public void AnotherInstance_ReadsTheFile()
    {
        WithTheClockPastEveryWrite().HashOf(PluginPath);

        using var held = HeldAgainstReaders();

        Assert.Null(WithTheClockPastEveryWrite().HashOf(PluginPath));
    }

    [Fact]
    public void AToolsRewriteThatKeepsSizeAndModificationTime_IsHashedAgain()
    {
        var hashes = WithTheClockPastEveryWrite();
        var rewritten = File.ReadAllBytes(PluginPath);
        rewritten[^1] ^= 0xFF;
        File.SetLastWriteTimeUtc(PluginPath, ModifiedOnAWholeDateTimeTick);
        hashes.HashOf(PluginPath);

        File.WriteAllBytes(PluginPath, rewritten);
        File.SetLastWriteTimeUtc(PluginPath, ModifiedOnAWholeDateTimeTick);

        Assert.Equal(Sha256Hex(rewritten), hashes.HashOf(PluginPath));
    }

    [Fact]
    public void AFileWhoseModificationTimeIsSetToItsOwnValue_IsReadAgain()
    {
        var hashes = WithTheClockPastEveryWrite();
        File.SetLastWriteTimeUtc(PluginPath, ModifiedOnAWholeDateTimeTick);
        hashes.HashOf(PluginPath);

        File.SetLastWriteTimeUtc(PluginPath, ModifiedOnAWholeDateTimeTick);
        using var held = HeldAgainstReaders();

        Assert.Null(hashes.HashOf(PluginPath));
    }

    [Fact]
    public void AFileWhoseStampIsWithinTheClockTickOfItsHash_IsReadAgain()
    {
        var hashes = new MutagenPluginAdapter(TimeProvider.System);
        hashes.HashOf(PluginPath);

        using var held = HeldAgainstReaders();

        Assert.Null(hashes.HashOf(PluginPath));
    }
}
