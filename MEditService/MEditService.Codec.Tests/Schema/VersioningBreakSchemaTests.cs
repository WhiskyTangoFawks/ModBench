using MEditService.Codec.Schema;
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
    public void EveryBreakOfEveryClassMutagenVersions_LeavesAMemberUnheld(GameRelease release)
    {
        var game = release switch
        {
            GameRelease.Fallout4 => typeof(Mutagen.Bethesda.Fallout4.Quest).Assembly,
            GameRelease.SkyrimSE => typeof(Mutagen.Bethesda.Skyrim.Quest).Assembly,
            _ => typeof(Mutagen.Bethesda.Starfield.Quest).Assembly,
        };
        var versioned = game.GetTypes()
            .Where(type => type is { IsClass: true, IsAbstract: false, IsPublic: true } && type.GetNestedType(VersioningBreaks.EnumName) is not null)
            .ToList();

        Assert.NotEmpty(versioned);
        foreach (var type in versioned)
        {
            var unheld = VersioningBreaks.UnheldWhen(type).Values.SelectMany(flags => flags).ToHashSet(StringComparer.Ordinal);
            var breaks = Enum.GetNames(type.GetNestedType(VersioningBreaks.EnumName) ?? throw new InvalidOperationException()).Select(flag => $"{VersioningBreaks.Member}.{flag}");
            Assert.True(breaks.All(unheld.Contains), $"{type.Name} leaves no member unheld under one of {string.Join(", ", breaks)}");
        }
    }
}
