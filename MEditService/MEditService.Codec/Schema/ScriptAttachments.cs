using System.Text.Json;

namespace MEditService.Codec.Schema;

/// <summary>One Papyrus script a document attaches: its name, and the member path that names it.</summary>
public readonly record struct ScriptAttachment(string Name, string FieldPath);

/// <summary>Which Papyrus scripts a document attaches, answered by the schema for its record type.</summary>
public static class ScriptAttachments
{
    public static List<ScriptAttachment> Collect(string text, IReadOnlyList<ColumnSpec> columns)
    {
        using var document = JsonDocument.Parse(text);
        var root = document.RootElement;
        var attached = new List<ScriptAttachment>();
        foreach (var col in columns)
        {
            FormReferences.WalkLeaves(DocumentNodes.VariantFor(col.Field, root), DocumentNodes.At(root, col.PropertyName), col.Name,
                leaf => leaf.IsScriptName,
                (_, path, value) => { if (FormReferences.ExtractString(value) is { Length: > 0 } name) attached.Add(new(name, path)); });
        }
        return attached;
    }
}
