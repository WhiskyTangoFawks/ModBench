using System.Security.Cryptography;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class PluginFileHashesTests : IDisposable
{
    private const string PluginName = "Stamped.esp";

    private readonly PluginFixtureData _data = new PluginFixtureBuilder("adapter-file-hashes")
        .WithPlugin(PluginName)
        .Build();

    private static string Sha256Hex(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private string PluginPath => Path.Combine(_data.DataFolder, PluginName);

    public void Dispose() => _data.Dispose();

    private static MutagenPluginAdapter WithTheClockPastEveryWrite() =>
        new(new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1)));

    private static Answer<FileClaim, PluginFailure> ClaimOf(string path) => TestAdapters.Mutagen().ClaimOf(path, GameRelease.Fallout4);

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
    public void TheClaimOfAFileCutShortInsideARecord_ReportsItsDiagnosesAsAFailure()
    {
        var whole = RawPlugin.Plugin(RawPlugin.Tes4(), RawPlugin.Group("MISC", RawPlugin.Misc(0x800, "Bottlecap")));
        File.WriteAllBytes(PluginPath, whole[..^4]);

        Assert.IsType<PluginFailure.Unparsed>(ClaimOf(PluginPath).Answered().Diagnoses.Failure());
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
}
