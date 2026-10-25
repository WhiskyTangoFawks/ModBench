using System.Text;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A real compiled plugin with no records of its own: a case seeds the document it needs,
/// then edits it through the real <see cref="EditRecordChangesHandler"/>, saving what it answers.</summary>
internal sealed class DocumentEditFixture : TestInstance
{
    private const string PluginName = "DocEdit.esp";

    internal static readonly ModKey ModKey = ModKey.FromFileName(PluginName);

    private ISourceRepository Repository => RepositoryOf(Plugin)
        ?? throw new InvalidOperationException($"Expected '{Plugin}' to already be a compiled plugin.");

    internal PluginAddress Plugin { get; }

    internal DocumentEditFixture(Language stringsLanguage = Language.English)
        : base(stringsLanguage: stringsLanguage) =>
        Plugin = Add(new Fallout4Mod(ModKey, Fallout4Release.Fallout4), "DocEditMod");

    /// <summary>Seeds the plugin's header as a localized plugin's.</summary>
    internal void Localize() =>
        SeedRaw(
            PluginHeader.FormKeyFor(ModKey), PluginHeader.RecordType, null,
            Encoding.UTF8.GetString(HeaderDocument.Write(new Fallout4Mod(ModKey, Fallout4Release.Fallout4) { UsingLocalization = true })));

    internal static FormKey KeyOf(uint id) => new(ModKey, id);

    /// <summary>Seeds the working tree with a real record's own codec-serialized document; returns
    /// its FormKey.</summary>
    internal string Seed(IMajorRecordGetter record, string recordType)
    {
        var text = RecordTextCodec.SerializeToText(record, GameRelease.Fallout4);
        SeedRaw(record.FormKey.ToString(), recordType, record.EditorID, text);
        return record.FormKey.ToString();
    }

    /// <summary>Seeds an exact document body, for a case whose input is a shape the codec itself
    /// would not produce.</summary>
    internal void SeedRaw(string formKey, string recordType, string? editorId, string body) =>
        Repository.Put(Plugin, new SourceDocument(formKey, recordType, editorId, body)).Wrote();

    internal string Document(string formKey) =>
        SourceModTree.Document(ModFolderOf(Plugin), Plugin, formKey)?.Body
            ?? throw new InvalidOperationException($"Expected a document for '{formKey}'.");

    /// <summary>Applies <paramref name="envelope"/> through the real handler; on success returns the
    /// document as it now reads, otherwise null (and the document is untouched).</summary>
    internal (RecordEditResult Result, string? After) Apply(string formKey, RecordEditEnvelope envelope)
    {
        var result = EditHandler.Edit(Plugin, formKey, envelope);
        return (result, result.Applied ? Document(formKey) : null);
    }

    /// <summary>Applies an edit that must land, and answers what it changed in the document.</summary>
    internal List<string> Changed(string formKey, RecordEditEnvelope envelope)
    {
        var before = Document(formKey);
        var (result, after) = Apply(formKey, envelope);
        Assert.True(result.Applied, result.Message);
        return DocumentDiffs.Of(before, after.Require());
    }

    /// <summary>The set that sends back a member's whole value with the one part at <paramref name="path"/>
    /// ("0.Data.Function") replaced.</summary>
    internal RecordEditEnvelope Resend(string formKey, string member, string path, string replacement)
    {
        var value = JsonNode.Parse(Document(formKey)).Require()[member].Require();
        var hops = path.Split('.');
        var owner = hops[..^1].Aggregate(value, (node, hop) => Step(node, hop).Require());
        var replaced = JsonNode.Parse(replacement);
        if (int.TryParse(hops[^1], out var index)) owner[index] = replaced;
        else owner[hops[^1]] = replaced;
        return Envelopes.Spelled(RecordEditEnvelope.Set, member, value.ToJsonString());
    }

    private static JsonNode? Step(JsonNode node, string hop) => int.TryParse(hop, out var index) ? node[index] : node[hop];

    /// <summary>Applies an edit that must be refused, and checks the document was left as it was.</summary>
    internal RecordEditResult Refused(string formKey, RecordEditEnvelope envelope)
    {
        var before = Document(formKey);
        var (result, _) = Apply(formKey, envelope);
        Assert.False(result.Applied);
        Assert.Equal(before, Document(formKey));
        return result;
    }
}
