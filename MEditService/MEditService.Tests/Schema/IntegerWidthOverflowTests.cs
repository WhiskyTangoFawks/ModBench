using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Schema;

/// <summary>Held at the <see cref="ColumnSpec.Apply"/> seam, where one converter table serves both
/// a scalar column and a bare-scalar list element, so the two cannot drift apart (#707).</summary>
public class IntegerWidthOverflowTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private static Func<IMajorRecord, JsonElement, ApplyOutcome> Writer(string table, string column)
    {
        var col = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[table]
            .RecordColumns.Single(c => c.Name == column);
        return col.Apply.Writer!;
    }

    private static IMajorRecord Record(string table) => table switch
    {
        "npc_" => new Npc(FormKey.Null, Fallout4Release.Fallout4),
        "revb" => new ReverbParameters(FormKey.Null, Fallout4Release.Fallout4),
        "misc" => new MiscItem(FormKey.Null, Fallout4Release.Fallout4),
        "imad" => new ImageSpaceAdapter(FormKey.Null, Fallout4Release.Fallout4),
        "weap" => new Weapon(FormKey.Null, Fallout4Release.Fallout4),
        "scco" => new SceneCollection(FormKey.Null, Fallout4Release.Fallout4),
        _ => throw new ArgumentOutOfRangeException(nameof(table)),
    };

    [Theory]
    // byte
    [InlineData("npc_", "energy_level", "256")]
    [InlineData("npc_", "energy_level", "-1")]
    // sbyte
    [InlineData("revb", "reverb_amp", "128")]
    [InlineData("revb", "reverb_amp", "-129")]
    // short
    [InlineData("npc_", "xp_value_offset", "32768")]
    [InlineData("npc_", "xp_value_offset", "-32769")]
    // ushort
    [InlineData("npc_", "calculated_health", "65536")]
    [InlineData("npc_", "calculated_health", "-1")]
    // uint
    [InlineData("npc_", "aggro_radius_warn", "4294967296")]
    [InlineData("npc_", "aggro_radius_warn", "-1")]
    // int
    [InlineData("weap", "unknown3", "2147483648")]
    [InlineData("weap", "unknown3", "-2147483649")]
    // ulong
    [InlineData("imad", "unknown", "18446744073709551616")]
    [InlineData("imad", "unknown", "-1")]
    public void OutOfRangeScalar_IsRejected(string table, string column, string value)
    {
        Assert.Equal(ApplyOutcome.ValueRejected, Writer(table, column)(Record(table), Json(value)));
    }

    [Theory]
    [InlineData("npc_", "energy_level", "255")]
    [InlineData("revb", "reverb_amp", "-128")]
    [InlineData("npc_", "xp_value_offset", "32767")]
    [InlineData("npc_", "calculated_health", "65535")]
    [InlineData("npc_", "aggro_radius_warn", "4294967295")]
    [InlineData("weap", "unknown3", "2147483647")]
    [InlineData("imad", "unknown", "18446744073709551615")]
    public void InRangeScalar_IsApplied(string table, string column, string value)
    {
        Assert.Equal(ApplyOutcome.Applied, Writer(table, column)(Record(table), Json(value)));
    }

    // long is the one width Fallout 4 gives no scalar column, so the list position is the whole
    // population and the width is pinned there instead.
    [Theory]
    [InlineData("[9223372036854775808]", ApplyOutcome.ValueRejected)]
    [InlineData("[-9223372036854775809]", ApplyOutcome.ValueRejected)]
    [InlineData("[1.5]", ApplyOutcome.ValueRejected)]
    [InlineData("[9223372036854775807, -9223372036854775808]", ApplyOutcome.Applied)]
    public void LongListElement_IsRejectedOnlyOutsideItsWidth(string value, ApplyOutcome expected)
    {
        Assert.Equal(expected, Writer("scco", "xnams")(Record("scco"), Json(value)));
    }

    [Fact]
    public void SameOutOfRangeByte_IsRejectedAsAScalarAndAsAListElement()
    {
        Assert.Equal(ApplyOutcome.ValueRejected,
            Writer("npc_", "energy_level")(Record("npc_"), Json("4096")));
        Assert.Equal(ApplyOutcome.ValueRejected,
            Writer("misc", "component_display_indices")(Record("misc"), Json("[3, 4096]")));
    }

    [Fact]
    public void OutOfRangeListElement_LeavesTheWholeListUntouched()
    {
        var misc = (MiscItem)Record("misc");
        misc.ComponentDisplayIndices = [9];

        Assert.Equal(ApplyOutcome.ValueRejected,
            Writer("misc", "component_display_indices")(misc, Json("[3, 4096]")));
        Assert.Equal<byte[]>([9], [.. misc.ComponentDisplayIndices!]);
    }
}
