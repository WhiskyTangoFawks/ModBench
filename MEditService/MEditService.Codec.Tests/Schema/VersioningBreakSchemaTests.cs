using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class VersioningBreakSchemaTests
{
    [Theory]
    [InlineData(GameRelease.Fallout4, "qust", "VirtualMachineAdapter.ExtraBindDataVersion", "Versioning.Break0")]
    [InlineData(GameRelease.Fallout4, "qust", "VirtualMachineAdapter.Script", "Versioning.Break0")]
    [InlineData(GameRelease.Fallout4, "qust", "VirtualMachineAdapter.Fragments", "Versioning.Break0")]
    [InlineData(GameRelease.Fallout4, "qust", "VirtualMachineAdapter.Aliases", "Versioning.Break0")]
    [InlineData(GameRelease.Fallout4, "qust", "VirtualMachineAdapter.Scripts", "")]
    [InlineData(GameRelease.Fallout4, "qust", "VirtualMachineAdapter.Versioning", "")]
    [InlineData(GameRelease.SkyrimSE, "qust", "VirtualMachineAdapter.ExtraBindDataVersion", "Versioning.Break0")]
    [InlineData(GameRelease.SkyrimSE, "qust", "VirtualMachineAdapter.FileName", "Versioning.Break0")]
    [InlineData(GameRelease.SkyrimSE, "qust", "VirtualMachineAdapter.Fragments", "Versioning.Break0")]
    [InlineData(GameRelease.SkyrimSE, "qust", "VirtualMachineAdapter.Aliases", "Versioning.Break0")]
    [InlineData(GameRelease.SkyrimSE, "qust", "VirtualMachineAdapter.Scripts", "")]
    [InlineData(GameRelease.Starfield, "qust", "VirtualMachineAdapter.ExtraBindDataVersion", "Versioning.Break0")]
    [InlineData(GameRelease.Starfield, "qust", "VirtualMachineAdapter.Script", "Versioning.Break0")]
    [InlineData(GameRelease.Starfield, "qust", "VirtualMachineAdapter.Fragments", "Versioning.Break0")]
    [InlineData(GameRelease.Starfield, "qust", "VirtualMachineAdapter.Aliases", "Versioning.Break0")]
    [InlineData(GameRelease.Starfield, "qust", "VirtualMachineAdapter.Scripts", "")]
    [InlineData(GameRelease.Fallout4, "cell", "Lighting.FarHeightMid", "Versioning.Break0, Versioning.Break1, Versioning.Break2")]
    [InlineData(GameRelease.Fallout4, "cell", "Lighting.FogNearScale", "Versioning.Break0, Versioning.Break1")]
    [InlineData(GameRelease.Fallout4, "cell", "Lighting.NearHeightMid", "Versioning.Break0")]
    [InlineData(GameRelease.Fallout4, "cell", "Lighting.FogNear", "")]
    public void AMember_IsUnheldUnderEachBreakItLiesPast(GameRelease release, string table, string path, string breaks)
    {
        Assert.Equal(breaks, string.Join(", ", SchemaFields.At(release, table, path).UnheldWhen ?? []));
    }

    public static TheoryData<GameRelease, string> VersionedStructs()
    {
        var rows = new TheoryData<GameRelease, string>();
        foreach (var release in new[] { GameRelease.Fallout4, GameRelease.SkyrimSE, GameRelease.Starfield })
        {
            foreach (var path in SchemaFields.All(release)
                .Where(found => found.Field.Fields?.Any(member => member is { Name: "Versioning", Type: "flags" }) == true)
                .Select(found => found.Path)
                .Distinct(StringComparer.Ordinal))
                rows.Add(release, path);
        }
        return rows;
    }

    [Theory]
    [MemberData(nameof(VersionedStructs))]
    public void EveryBreakOfAStructMutagenVersions_LeavesAMemberUnheld(GameRelease release, string path)
    {
        var members = SchemaFields.All(release).First(found => found.Path == path).Field.Fields ?? [];

        Assert.Subset(
            members.SelectMany(member => member.UnheldWhen ?? []).ToHashSet(StringComparer.Ordinal),
            members.Single(member => member.Name == "Versioning").EnumMembers.Select(flag => $"Versioning.{flag.Value}").ToHashSet(StringComparer.Ordinal));
    }
}
