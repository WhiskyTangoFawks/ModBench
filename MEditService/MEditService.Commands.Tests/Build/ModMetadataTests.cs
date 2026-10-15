using MEditService.Commands.Build;

namespace MEditService.Commands.Tests.Build;

public sealed class ModMetadataTests
{
    private static ModMetadata Metadata(string? version, params (string Name, string? Source)[] files) =>
        new(version, [.. files.Select(file => new MetadataInstallationFile(file.Name, file.Source))]);

    [Fact]
    public void AVersionThatIsNotTheManifests_Differs()
    {
        Assert.True(Metadata("1.0").DiffersFrom(Metadata("2.0")));
    }

    [Fact]
    public void ASourceThatIsNotTheManifests_Differs()
    {
        Assert.True(Metadata(null, ("a.7z", "nexus:fallout4:1")).DiffersFrom(Metadata(null, ("a.7z", "nexus:fallout4:2"))));
    }

    [Fact]
    public void AnInstallationFileOtherThanTheManifests_Differs()
    {
        Assert.True(Metadata(null, ("old.7z", null)).DiffersFrom(Metadata(null, ("new.7z", null))));
    }

    [Fact]
    public void MetadataHoldingNothing_DiffersFromNothing()
    {
        Assert.False(Metadata(null).DiffersFrom(Metadata("2.0", ("a.7z", "nexus:fallout4:1"))));
    }

    [Fact]
    public void AManifestSayingNothing_ReplacesNothing()
    {
        Assert.False(Metadata("1.0", ("a.7z", "nexus:fallout4:1")).DiffersFrom(Metadata(null)));
    }

    [Fact]
    public void MetadataThatAgrees_DiffersFromNothing()
    {
        var held = Metadata("1.0", ("a.7z", "nexus:fallout4:1"));

        Assert.False(held.DiffersFrom(held));
    }

    [Fact]
    public void ASourceEitherSideLacks_ReplacesNothing()
    {
        Assert.False(Metadata(null, ("a.7z", null)).DiffersFrom(Metadata(null, ("a.7z", "nexus:fallout4:1"))));
    }
}
