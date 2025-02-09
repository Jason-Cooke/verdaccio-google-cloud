const results = [];
const _symbol = Symbol('KEY');
const defaultQueryBody = {
  endCursor: 'CjgSMmoOZX52ZXJkYW=',
  moreResults: 'NO_MORE_RESULTS'
};
const defaultResuponse = [results, defaultQueryBody];
const keyContent = () => {
  const id = Math.random();

  return {
    namespace: undefined,
    id,
    kind: 'metadataDatabaseKey',
    path: ['metadataDatabaseKey', `${id}`]
  };
};

export default class Storage {
  constructor() {
    this.KEY = _symbol;
  }

  int(id) {
    return id;
  }

  key(_key) {
    return _key;
  }

  save(toSave) {
    const data = toSave.data;
    data[this.KEY] = keyContent();

    results.push(data);
    return Promise.resolve();
  }

  update() {
    return {};
  }

  delete(key) {
    const id = key[1];
    const counter = 1;
    const elementToRemove = results.filter((item, index) => {
      const medatada = item[this.KEY];

      if (medatada.id === id) {
        results.splice(index, 0);
        return true;
      }

      return false;
    });

    const response = {
      indexUpdates: counter,
      mutationResults: elementToRemove
    };

    return Promise.resolve([response]);
  }

  createQuery() {
    return {
      filter: (key, valueQuery) => valueQuery
    };
  }
  runQuery(query) {
    if (query === 'createPkg1') {
      return Promise.resolve([[], defaultQueryBody]);
    } else {
      return Promise.resolve(defaultResuponse);
    }
  }
}
