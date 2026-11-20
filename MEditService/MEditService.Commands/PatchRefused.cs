using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;

namespace MEditService.Commands;

/// <summary>A record a Modbench script gives a generated patch plugin: a document as plugin source holds it, and its record
/// type, which a record no active or compiled plugin holds needs.</summary>
public sealed record GivenRecord(string Text, string? RecordType = null);

/// <summary>The generated patch plugin written, and compile's diagnostics of it.</summary>
public sealed record PatchMade(PluginAddress Plugin, IReadOnlyList<CompileDiagnostic> Diagnostics);

/// <summary>Why making a generated patch plugin wrote nothing, and the message naming the way out (ADR-0019).</summary>
public abstract record PatchRefused(string Message)
{
    /// <summary>Refused as creating a plugin there is.</summary>
    public sealed record AsCreate(PluginCreateRefusal Refusal, string Message) : PatchRefused(Message);

    /// <summary>Refused as compiling the records is (scripts.md, Writing, story 8).</summary>
    public sealed record AsCompile(CompileRefusal Refusal, string Message) : PatchRefused(Message);

    /// <summary>A record given that no plugin's copy says how to lay out.</summary>
    public sealed record OfRecord(RecordEditRefusal Refusal, string Message) : PatchRefused(Message);

    /// <summary>The record index cannot yet say which plugin holds a record given.</summary>
    public sealed record OfIndex(IndexRefused Refused) : PatchRefused(Refused.Message);
}
