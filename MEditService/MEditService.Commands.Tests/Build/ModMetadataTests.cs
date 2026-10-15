using MEditService.Commands.Build;
using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Tests.Build;

public sealed class ModMetadataTests
{
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

    [Theory]
    [MemberData(nameof(Cases))]
    public void WritingTheManifestsMetadata_ReplacesAValueHeld_OnlyWhenTheyDiffer(ModMetadata held, ModMetadata manifest, bool differs)
    {
        var sources = manifest.InstallationFiles.Select(file => new ManifestSource(file.Name, 1, "hash", file.Source)).ToList();

        var metadata = RestoreMetadata.Of(new ModByFolder("Mod", "mods/Mod", [], held), new Manifest(sources, [], [], manifest.Version));

        Assert.Equal(differs, metadata?.Differs);
    }

    [Fact]
    public void AModWithNoManifest_SaysNothing() =>
        Assert.Null(RestoreMetadata.Of(new ModByFolder("Mod", "mods/Mod", [], Metadata("1.0")), manifest: null));
}
