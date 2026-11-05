using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class VersioningBreakSchemaTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4, "Script")]
    [InlineData(GameRelease.SkyrimSE, "FileName")]
    [InlineData(GameRelease.Starfield, "Script")]
    public void AQuestAdaptersFragmentBlock_IsUnheldUnderItsBreak_AndItsScriptsNever(GameRelease release, string fragmentScript)
    {
        foreach (var member in new[] { "ExtraBindDataVersion", fragmentScript, "Fragments", "Aliases" })
            Assert.Equal(["Versioning.Break0"], SchemaFields.At(release, "qust", $"VirtualMachineAdapter.{member}").UnheldWhen);
        Assert.Null(SchemaFields.At(release, "qust", "VirtualMachineAdapter.Scripts").UnheldWhen);
        Assert.Null(SchemaFields.At(release, "qust", "VirtualMachineAdapter.Versioning").UnheldWhen);
    }

    [Fact]
    public void AMemberPastSeveralBreaks_IsUnheldUnderEachOfThem()
    {
        Assert.Equal(["Versioning.Break0", "Versioning.Break1", "Versioning.Break2"], SchemaFields.At(GameRelease.Fallout4, "cell", "Lighting.FarHeightMid").UnheldWhen);
        Assert.Equal(["Versioning.Break0"], SchemaFields.At(GameRelease.Fallout4, "cell", "Lighting.NearHeightMid").UnheldWhen);
        Assert.Null(SchemaFields.At(GameRelease.Fallout4, "cell", "Lighting.FogNear").UnheldWhen);
    }

    [Theory]
    [InlineData(GameRelease.Fallout4)]
    [InlineData(GameRelease.SkyrimSE)]
    [InlineData(GameRelease.Starfield)]
    public void EveryBreakOfEveryStructMutagenVersions_LeavesAMemberUnheld(GameRelease release)
    {
        var versioned = SchemaFields.All(release)
            .Where(found => found.Field.Fields?.Any(member => member is { Name: "Versioning", Type: "flags" }) == true)
            .ToList();

        Assert.NotEmpty(versioned);
        foreach (var (path, field) in versioned)
        {
            var members = field.Fields ?? [];
            var breaks = members.Single(member => member.Name == "Versioning").EnumMembers.Select(flag => $"Versioning.{flag.Value}").ToList();
            var unheld = members.SelectMany(member => member.UnheldWhen ?? []).ToHashSet(StringComparer.Ordinal);
            Assert.True(breaks.TrueForAll(unheld.Contains), $"{path} leaves no member unheld under one of {string.Join(", ", breaks)}");
        }
    }
}
