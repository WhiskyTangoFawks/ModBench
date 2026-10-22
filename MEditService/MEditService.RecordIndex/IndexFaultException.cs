namespace MEditService.RecordIndex;

/// <summary>What the record index's database refused, in the index's own words.</summary>
internal enum IndexFault
{
    /// <summary>A fatal error, a failed checkpoint among them, invalidated the database; it answers nothing until its file is opened again.</summary>
    Invalidated,
    OutOfMemory,
    /// <summary>The SQL's own fault: a caller's SQL, or a value a row holds.</summary>
    BadSql,
}

internal sealed class IndexFaultException : InvalidOperationException
{
    internal IndexFaultException()
    {
    }

    internal IndexFaultException(string message) : base(message)
    {
    }

    internal IndexFaultException(string message, Exception innerException) : base(message, innerException)
    {
    }

    public IndexFault Fault { get; init; }
}
