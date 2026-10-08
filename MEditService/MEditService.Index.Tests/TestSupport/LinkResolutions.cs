using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Index.Queries;
using MEditService.LoadOrder;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>What a link resolves to, as the compare shows it on the link's cell.</summary>
internal static class LinkResolutions
{
    /// <summary>A link to <paramref name="target"/>, resolved: <paramref name="npc"/>'s copy in
    /// <paramref name="plugin"/> with its Race pointed at the target, compared as the editor sends it.</summary>
    internal static FormKeyResolution ResolutionOf(this OpenedIndex index, string npc, PluginAddress plugin, string target)
    {
        var document = JsonNode.Parse(index.BodyOf(npc, plugin))?.AsObject()
            ?? throw new InvalidOperationException($"Expected {npc}'s document to be an object.");
        document["Race"] = target;
        var compare = index.Records.GetCompare(npc, new CopyText(plugin, document.ToJsonString()))
            ?? throw new InvalidOperationException($"Expected {npc} to compare.");
        return compare.Diffs.Single(diff => diff.FieldName == "Race").Resolutions?.Values.Single()
            ?? throw new InvalidOperationException($"Expected the link to {target} to resolve or not.");
    }
}
