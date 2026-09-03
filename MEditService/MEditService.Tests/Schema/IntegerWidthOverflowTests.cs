using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Schema;

/// <summary>
/// #707: a value the column's own integer width cannot hold is refused, not truncated into it.
/// <c>SchemaReflector.PrimitiveMap</c>'s narrowing converters are the one table both positions share
/// — a scalar column (<c>MakeApplier</c>) and a bare-scalar list element
/// (<c>BuildScalarListElement</c>) — so the two agree by construction, and these tests hold them to
/// it at the <see cref="ColumnSpec.Apply"/> seam, one layer below the edit service.
///
/// <para>The rule: an out-of-range value refuses the <i>whole</i> write, never the offending element
/// alone — the same all-or-nothing every other declined element already gets
/// (<c>ApplyListJson</c>'s fold), so a refused array never lands with a hole in it.</para>
/// </summary>
public class IntegerWidthOverflowTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private static Func<IMajorRecord, JsonElement, ApplyOutcome> Writer(string table, string column)
    {
        var col = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)[table]
            .RecordColumns.First(c => c.Name == column);
        return col.Apply.Writer!;
    }

    private static IMajorRecord Record(string table) => table switch
    {
        "npc_" => new Npc(FormKey.Null, Fallout4Release.Fallout4),
        "revb" => new ReverbParameters(FormKey.Null, Fallout4Release.Fallout4),
        "misc" => new MiscItem(FormKey.Null, Fallout4Release.Fallout4),
        _ => throw new ArgumentOutOfRangeException(nameof(table)),
    };

    /// <summary>One column per integer width, each given a value one step outside it in both
    /// directions. The four narrowed widths (byte/sbyte/short/ushort) cast from <c>GetInt32</c> and
    /// are what <c>checked</c> fixes; <c>uint</c> reaches <c>GetUInt32</c>, the JSON reader's own
    /// range-checked accessor, and is here to pin that the whole table answers alike.</summary>
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
    public void InRangeScalar_IsApplied(string table, string column, string value)
    {
        Assert.Equal(ApplyOutcome.Applied, Writer(table, column)(Record(table), Json(value)));
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
