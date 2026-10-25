using System.Globalization;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Codec.Tests.Schema;

public sealed class DeclaredDefaultTests
{
    [Theory]
    [InlineData("npc_", "VirtualMachineAdapter.ObjectFormat", "2")]
    [InlineData("npc_", "VirtualMachineAdapter.Version", "6")]
    [InlineData("npc_", "VirtualMachineAdapter.Scripts.[].Name", null)]
    [InlineData("npc_", "HeightMin", null)]
    [InlineData("npc_", "VirtualMachineAdapter.Scripts.[].Properties.[].Flags", "Edited")]
    [InlineData("cobj", "Conditions.[].Data.RunOnType", "Subject")]
    [InlineData("dial", "Priority", "50")]
    [InlineData("ligh", "Color", "#00000000")]
    [InlineData("mato", "ProjectionVector", "0, 0, 0")]
    [InlineData("race", "Unknown", "0x0000000000000000")]
    public void AFieldsDefault_IsTheOneMutagenDeclaresOrTheCodecsSpellingOfItsZero(string table, string path, string? expected)
    {
        var field = SchemaFields.At(GameRelease.Fallout4, table, path);

        Assert.Equal(expected, field.Default is null ? null : Convert.ToString(field.Default, CultureInfo.InvariantCulture));
    }
}
