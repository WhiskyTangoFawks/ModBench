using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Schema;

/// <summary>#707: a value the column's own integer width cannot hold refuses the whole write rather
/// than truncating into it. Held at the <see cref="ColumnSpec.Apply"/> seam, where the one converter
/// table <c>SchemaReflector.PrimitiveMap</c> serves both positions — a scalar column and a
/// bare-scalar list element — so the two cannot drift apart.</summary>
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

    /// <summary>One column per integer width the table maps, each given a value one step outside it
    /// in both directions. The four narrowed widths (byte/sbyte/short/ushort) cast from
    /// <c>GetInt32</c> and are what <c>checked</c> fixes; int/uint/ulong reach <c>GetInt32</c>/
    /// <c>GetUInt32</c>/<c>GetUInt64</c>, the JSON reader's own range-checked accessors, and are here
    /// so the whole table is pinned to one answer rather than three widths being taken on trust.
    /// <c>long</c> is the one width with no Fallout 4 scalar column to name; it is pinned at the list
    /// position instead, by <see cref="LongListElement_IsRejectedOnlyOutsideItsWidth"/>.</summary>
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

    /// <summary>The positive control: the widest value each width <i>can</i> hold still lands, so the
    /// refusals above are about the range and not about the column having gone read-only.</summary>
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

    /// <summary>The one width held at the list position instead: Fallout 4 has no <c>long</c> scalar
    /// column at all — <c>scco.xnams</c>, a list of <c>long</c>, is the whole population — so the same range
    /// question is asked of the list element the shared converter table serves. <c>GetInt64</c>
    /// range-checks itself and throws <see cref="FormatException"/>, so the answer matches the
    /// widths above without a <c>checked</c> cast.</summary>
    [Theory]
    [InlineData("[9223372036854775808]", ApplyOutcome.ValueRejected)]
    [InlineData("[-9223372036854775809]", ApplyOutcome.ValueRejected)]
    [InlineData("[1.5]", ApplyOutcome.ValueRejected)]
    [InlineData("[9223372036854775807, -9223372036854775808]", ApplyOutcome.Applied)]
    public void LongListElement_IsRejectedOnlyOutsideItsWidth(string value, ApplyOutcome expected)
    {
        Assert.Equal(expected, Writer("scco", "xnams")(Record("scco"), Json(value)));
    }

    /// <summary>AC 3, the pair the ticket turns on: 4096 into a byte is the same answer whether it
    /// arrives as a scalar column's whole value or as one element of a byte-element list.</summary>
    [Fact]
    public void SameOutOfRangeByte_IsRejectedAsAScalarAndAsAListElement()
    {
        Assert.Equal(ApplyOutcome.ValueRejected,
            Writer("npc_", "energy_level")(Record("npc_"), Json("4096")));
        Assert.Equal(ApplyOutcome.ValueRejected,
            Writer("misc", "component_display_indices")(Record("misc"), Json("[3, 4096]")));
    }

    /// <summary>The refusal is of the whole array — the in-range sibling element does not land
    /// either, so no half-written list reaches the record.</summary>
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
