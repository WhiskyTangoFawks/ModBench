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

    private static ModMetadata Metadata(string? version, params (string Name, string? Page)[] files) =>
        new(version, files is [var file] ? new MetadataInstallationFile(file.Name, file.Page) : null);

    public static TheoryData<ModMetadata, ModMetadata, bool> RestoreCases => new()
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
        { Metadata(null, ("a.7z", null)), Metadata(null), false },
        { Metadata("1.0", ("a.7z", null)), Metadata(null, ("a.7z", null)), false },
    };

    private ModStatus StatusAgainst(ModMetadata manifest, ModMetadata? held)
    {
        ManifestPackage? package = manifest.InstallationFile is { } file
            ? new ManifestPackage.InstallationFile(file.Name, 1, "hash", file.Page)
            : manifest.Version is not null ? new ManifestPackage.GameFolder("Fallout4", "hash") : null;
        _repository.WriteManifest(_root, "mod", new Manifest(package, [], manifest.Version));
        return _repository.Status(_root, "mod", new HashSet<string>(), _statCache, held, sourceFolder: null);
    }

    [Theory]
    [MemberData(nameof(RestoreCases))]
    public void RestoringTheManifestsMetadata_OverwritesAValue_OnlyWhereBothHoldOne(ModMetadata held, ModMetadata manifest, bool overwrites) =>
        Assert.Equal(overwrites, held.IsOverwrittenBy(manifest));

    public static TheoryData<ModMetadata?, ModMetadata, bool> StatusCases => new()
    {
        { Metadata("1.0"), Metadata("1.0"), false },
        { Metadata("1.0"), Metadata("2.0"), true },
        { Metadata(null), Metadata("2.0"), true },
        { Metadata(null, ("a.7z", "nexus:fallout4:1")), Metadata(null, ("a.7z", "nexus:fallout4:1")), false },
        { Metadata(null, ("a.7z", "nexus:fallout4:1")), Metadata(null, ("a.7z", "nexus:fallout4:2")), true },
        { Metadata(null, ("a.7z", null)), Metadata(null, ("a.7z", "nexus:fallout4:1")), true },
        { Metadata(null, ("a.7z", "nexus:fallout4:1")), Metadata(null, ("a.7z", null)), true },
        { Metadata(null, ("old.7z", null)), Metadata(null, ("new.7z", null)), true },
        { Metadata(null, ("a.7z", null)), Metadata(null), true },
        { Metadata(null), Metadata(null, ("a.7z", null)), true },
        { Metadata(null), Metadata(null), false },
        { Metadata("1.0", ("a.7z", null)), Metadata(null, ("a.7z", null)), true },
        { Metadata("1.0"), Metadata(null), false },
        { null, Metadata("1.0"), false },
    };

    [Theory]
    [MemberData(nameof(StatusCases))]
    public void AModsMetadata_DiffersFromItsManifests_WhereUpdatingTheManifestWouldWriteAnother(ModMetadata? held, ModMetadata manifest, bool differs) =>
        Assert.Equal(differs, StatusAgainst(manifest, held).MetadataDiffers);

    [Fact]
    public void AStatus_AnswersWhatItsManifestSaysOfTheMetadata()
    {
        var says = StatusAgainst(Metadata("1.0", ("a.7z", "nexus:fallout4:1")), null).ManifestMetadata;

        Assert.Equal("1.0", says?.Version);
        Assert.Equal(new MetadataInstallationFile("a.7z", "nexus:fallout4:1"), says?.InstallationFile);
    }

    [Fact]
    public void AModWithNoManifest_HasNoMetadataToDifferFrom()
    {
        var status = _repository.Status(_root, "mod", new HashSet<string>(), _statCache, Metadata("1.0"), sourceFolder: null);

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
