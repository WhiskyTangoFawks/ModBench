using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class VersioningBreakSchemaTests
{
    [Theory]
    [InlineData("qust", "VirtualMachineAdapter.Script", "Versioning.Break0")]
    [InlineData("qust", "VirtualMachineAdapter.Scripts", "")]
    [InlineData("qust", "VirtualMachineAdapter.Versioning", "")]
    [InlineData("cell", "Lighting.FarHeightMid", "Versioning.Break0, Versioning.Break1, Versioning.Break2")]
    [InlineData("cell", "Lighting.NearHeightMid", "Versioning.Break0")]
    public void AMember_IsUnheldUnderEachBreakItLiesPast(string table, string path, string breaks)
    {
        Assert.Equal(breaks, string.Join(", ", SchemaFields.At(GameRelease.Fallout4, table, path).UnheldWhen ?? []));
    }
}
