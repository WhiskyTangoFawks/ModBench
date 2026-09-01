using System.Text;
using DuckDB.NET.Data;
using MEditService.Core.Source;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>
/// Indexes a plugin's ModHeader as an <b>ordinary <c>records</c> row</b> (#631) at the synthetic
/// FormKey <c>000000:&lt;plugin&gt;</c>, whose body is the whole-mod door's root
/// <c>RecordData.json</c> (<see cref="HeaderDocument"/>).
///
/// <para>A ModHeader is never an <see cref="IMajorRecordGetter"/>, so it still bypasses the
/// major-record indexing loop — but that is now the <i>only</i> thing special about it. It carries the
/// same columns as every other row (<c>record_type</c>, <c>ref</c>, <c>body</c>,
/// <c>content_hash</c>), wins its FormKey through the same sweep, is read back through the same
/// document path, and hashes to a real git object name comparable against the source tree in one ref
/// read (<see cref="GitBlobHash"/>) — where before it was a per-type wide table sitting outside the
/// dual-ref model entirely.</para>
///
/// <para>Its FormKeys cannot collide with a record's: <see cref="FormKeyFor"/> mints them at FormID
/// <c>000000</c>, the null form, which no major record can occupy.</para>
/// </summary>
internal static class HeaderIndexer
{
    /// <summary>The synthetic <c>record_type</c> the plugin header is indexed under. No table bears
    /// this name any more (#631 retired the wide table) — it is a value in <c>records.record_type</c>
    /// and a key in the reflected schema map, nothing else.</summary>
    internal const string RecordType = "header";

    /// <summary>
    /// The header's masters field name — the reflected schema's own column
    /// (<c>SchemaReflector.BuildHeaderSchema</c>), which carries <c>Apply: null</c> so a write against
    /// it is refused as not-writable rather than silently accepted (#335/ADR-0038: masters are wholly
    /// content-derived at compile time, unconditionally, so there is nothing to key a write-time
    /// override off of).
    ///
    /// <para><b>Reachable since #661, and not specially enforced when it is.</b> The header became a
    /// first-class source unit, so <c>EditField</c> no longer refuses it at the gate
    /// (<c>RecordEditRefusal.SourceUnitNotFound</c>) — it answers off the schema instead
    /// (<c>RecordEditService.RefuseHeaderFieldEdit</c>) and reaches this column's <c>Apply: null</c>
    /// for real. That refusal (<c>FieldReadOnly</c>) is not masters-specific: every header column
    /// carries <c>Apply: null</c> today — <c>author</c>/<c>flags</c> simply because giving them a
    /// write delegate is #290's work, not this ticket's — so masters refuses for the identical reason
    /// its writable-looking siblings do. This constant is never consulted as a runtime branch anywhere;
    /// the missing delegate is the entire enforcement.</para>
    /// </summary>
    internal const string MastersFieldName = "masters";

    public static string FormKeyFor(ModKey plugin) => FormKey.Factory($"000000:{plugin}").ToString();

    /// <summary>
    /// Appends this plugin's header row onto the shared <c>records</c> appender, and returns the
    /// <c>form_lookup</c> row that goes with it.
    ///
    /// <para>No delete step of its own: the row lives in <c>records</c>, which
    /// <c>PluginIngest.DeletePriorDocuments</c> already clears wholesale for this (plugin, origin)
    /// before the appender exists. Returning the lookup row rather than writing it keeps ADR-0031's
    /// one-lookup-row-per-record-row invariant a property of a single flush instead of two writers
    /// that could drift.</para>
    /// </summary>
    public static (string FormKey, string RecordType, string? EditorId) Index(
        IModGetter pluginMod, string plugin, string origin, DuckDBAppender documentAppender)
    {
        var formKey = FormKeyFor(pluginMod.ModKey);
        var body = HeaderDocument.Write(pluginMod);

        var row = documentAppender.CreateRow();
        row.AppendValue(formKey);
        row.AppendValue(plugin);
        row.AppendValue(origin);
        row.AppendValue(RecordType);
        row.AppendNullValue();    // editor_id: headers have no EditorID concept
        row.AppendValue(SourceRef.Committed);
        row.AppendValue(Encoding.UTF8.GetString(body));
        // Hashed from the document's own bytes, never from a string round trip — identical for the
        // valid UTF-8 the door emits, but it keeps the hash defined by what the source file holds.
        // Same rule, same call, as PluginIngest.PrepareRecord.
        row.AppendValue(GitBlobHash.Of(body));
        row.EndRow();

        return (formKey, RecordType, null);
    }
}
