using MEditService.TestSupport;

namespace MEditService.ModFolderAdapter.Tests;

public sealed class ModStatusMetadataTests : IDisposable
{
    private readonly ScratchDirectory _root = new("modfolder-metadata-");
    private readonly ScratchDirectory _statCache = new("stat-cache-");
    private readonly ModFolderRepository _repository = new(TimeProvider.System);

    public void Dispose()
    {
        _root.Dispose();
        _statCache.Dispose();
    }

    private static ModMetadata Metadata(string? version, params (string Name, string? Source)[] files) =>
        new(version, [.. files.Select(file => new MetadataInstallationFile(file.Name, file.Source))]);

    public static TheoryData<ModMetadata, ModMetadata, bool> Cases => new()
    {
        { Metadata("1.0"), Metadata("2.0"), true },
        { Metadata("1.0"), Metadata("1.0"), false },
        { Metadata(null), Metadata("2.0"), false },
        { Metadata("1.0"), Metadata(null), false },
        { Metadata(null, ("a.7z", "nexus:fallout4:1")), Metadata(null, ("a.7z", "nexus:fallout4:2")), true },
        { Metadata(null, ("a.7z", "nexus:fallout4:1")), Metadata(null, ("a.7z", "nexus:fallout4:1")), false },
        { Metadata(null, ("a.7z", null)), Metadata(null, ("a.7z", "nexus:fallout4:1")), false },
        { Metadata(null, ("a.7z", "nexus:fallout4:1")), Metadata(null, ("a.7z", null)), false },
        { Metadata(null, ("old.7z", null)), Metadata(null, ("new.7z", null)), true },
        { Metadata(null, ("b.7z", "nexus:fallout4:2")), Metadata(null, ("a.7z", "nexus:fallout4:1"), ("b.7z", "nexus:fallout4:2")), false },
        { Metadata(null, ("b.7z", "nexus:fallout4:2")), Metadata(null, ("a.7z", "nexus:fallout4:1"), ("b.7z", "nexus:fallout4:3")), true },
        { Metadata(null, ("a.7z", null)), Metadata(null), false },
    };

    private ModStatus StatusAgainst(ModMetadata manifest, ModMetadata? held)
    {
        var sources = manifest.InstallationFiles.Select(file => new ManifestSource(file.Name, 1, "hash", file.Source)).ToList();
        _repository.WriteManifest(_root, "mod", new Manifest(sources, [], [], manifest.Version));
        return _repository.Status(_root, "mod", new HashSet<string>(), _statCache, held);
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void AModsMetadata_DiffersFromItsManifests_OnlyInAValueBothHold(ModMetadata held, ModMetadata manifest, bool differs) =>
        Assert.Equal(differs, StatusAgainst(manifest, held).MetadataDiffers);

    [Fact]
    public void AModWhoseMetadataIsNotHeld_DiffersFromNothing() =>
        Assert.False(StatusAgainst(Metadata("1.0"), held: null).MetadataDiffers);

    [Fact]
    public void AStatus_AnswersWhatItsManifestSaysOfTheMetadata()
    {
        var says = StatusAgainst(Metadata("1.0", ("a.7z", "nexus:fallout4:1")), null).ManifestMetadata;

        Assert.Equal("1.0", says?.Version);
        Assert.Equal([new MetadataInstallationFile("a.7z", "nexus:fallout4:1")], says?.InstallationFiles);
    }

    [Fact]
    public void AModWithNoManifest_HasNoMetadataToDifferFrom()
    {
        var status = _repository.Status(_root, "mod", new HashSet<string>(), _statCache, Metadata("1.0"));

        Assert.False(status.MetadataDiffers);
        Assert.Null(status.ManifestMetadata);
    }

    [Fact]
    public void TwoStatuses_AreEqualOnlyWhenTheyAgreeWhetherTheMetadataDiffers()
    {
        var plain = StatusAgainst(Metadata("1.0"), Metadata("1.0"));

        Assert.NotEqual(plain, plain with { MetadataDiffers = true });
    }
}
